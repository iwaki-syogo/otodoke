// The view model of ParcelListView (src/app/app/page.tsx + delivered-controls.tsx).
// Sections and order come from ParcelRules (checked against the Web by the parity harness).
// Every write goes through ParcelWriter on the version the screen shows (Codex-P2), and its result is
// one of three (Codex-P3): a success moves the card and offers 「元に戻す」 for 6 seconds; a write that
// surely did not happen leaves the card where it was with a message; an unknown result is never sent
// again: the list is read again, and if that read fails too, the card says 「確かめられませんでした」.

import Foundation
import Observation

/// The notice at the bottom: 「届いたにしました」/「N 件を受取済にしました」 with 「元に戻す」, or a failure.
struct ListToast: Equatable, Sendable {
    let text: String
    let canUndo: Bool
}

@MainActor
@Observable
final class ParcelListModel {
    typealias Sleep = @Sendable (Duration) async throws -> Void

    static let toastDuration: Duration = .seconds(6)
    /// 要確認 shows this many, the rest behind 「ほか N 件を見る」.
    static let toCheckHeadCount = 5

    static let savedText = "届いたにしました"
    static let saveFailedText = "保存できませんでした。もう一度スワイプしてください。"
    static let deliverAllFailedText = "保存できませんでした。もう一度押してください。"
    static let undoFailedText = "元に戻せませんでした"
    static let unconfirmedText = "確かめられませんでした"

    enum LoadState: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed
    }

    let reader: ParcelReader
    let writer: ParcelWriter

    private(set) var loadState: LoadState = .idle
    /// The parcels in ParcelRules.baseOrder.
    private(set) var rows: [ParcelRow] = []
    /// nil until the first load.
    private(set) var counts: ParcelCounts?
    /// Ids whose 「届いた」 is being saved (保存中…).
    private(set) var saving: Set<String> = []
    /// Per-card messages: 保存できませんでした。もう一度スワイプしてください。 / 確かめられませんでした
    private(set) var rowMessages: [String: String] = [:]
    private(set) var toast: ListToast?
    private(set) var isUndoing = false
    private(set) var isDeliveringAll = false
    /// Under 「すべて受取済にする」 when some of them could not be saved.
    private(set) var deliverAllMessage: String?

    @ObservationIgnored private let today: @Sendable () -> String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let sleep: Sleep
    /// What 「元に戻す」 on the current toast puts back: only the rows that were written.
    @ObservationIgnored private var undoTokens: [UndoToken] = []
    /// Bumped by every new toast, so an older timer never clears a newer toast.
    @ObservationIgnored private var toastGeneration = 0
    @ObservationIgnored private var toastTimer: Task<Void, Never>?

    init(
        reader: ParcelReader,
        writer: ParcelWriter,
        today: @escaping @Sendable () -> String,
        now: @escaping @Sendable () -> Date,
        sleep: @escaping Sleep
    ) {
        self.reader = reader
        self.writer = writer
        self.today = today
        self.now = now
        self.sleep = sleep
    }

    /// The app's model: the device clock, JST days and real sleeps.
    static func live(reader: ParcelReader, writer: ParcelWriter) -> ParcelListModel {
        ParcelListModel(
            reader: reader,
            writer: writer,
            today: { Format.todayJst(now: Date()) },
            now: { Date() },
            sleep: { try await Task.sleep(for: $0) }
        )
    }

    /// Today (YYYY-MM-DD, JST), for the cards.
    var todayJst: String { today() }

    /// ParcelRules.sections(rows, today: today()).
    var sections: ParcelSections { ParcelRules.sections(rows, today: today()) }
    /// Loaded, and no parcel at all.
    var isEmpty: Bool { loadState == .loaded && rows.isEmpty }
    /// 「届いた荷物は、左にスワイプして「届いた」にできます」 shows when there is an open parcel.
    var showsSwipeHint: Bool { loadState == .loaded && !sections.open.isEmpty }
    var toCheckHead: [ParcelRow] { Array(sections.toCheck.prefix(Self.toCheckHeadCount)) }
    var toCheckRest: [ParcelRow] { Array(sections.toCheck.dropFirst(Self.toCheckHeadCount)) }
    /// 「まだ読んでいないメールが N 通あります。この一覧は最新ではないかもしれません。」 when N > 0.
    var waitingNotice: String? {
        guard let n = counts?.unread.value, n > 0 else { return nil }
        return "まだ読んでいないメールが \(n) 通あります。この一覧は最新ではないかもしれません。"
    }
    /// nil when the count could not be read (the link shows without a number).
    var deliveredCount: Int? { counts?.delivered.value }
    var cancelledCount: Int? { counts?.cancelled.value }
    /// 「すべて受取済にする」 can be pressed: something to check, and no more than ParcelWriter.maxAtOnce.
    var deliverAllEnabled: Bool {
        let n = sections.toCheck.count
        return n > 0 && n <= ParcelWriter.maxAtOnce && !isDeliveringAll
    }

    // MARK: reading

    /// Reads the list and the counts (also pull to refresh). A failed list is 「読み込めませんでした」,
    /// never an empty list; the counts show on their own either way.
    func load() async {
        if loadState == .idle { loadState = .loading }
        if await reread() {
            rowMessages = [:]
            deliverAllMessage = nil
        } else {
            rows = []
            loadState = .failed
        }
    }

    /// Reads the list and the counts. The counts are taken as they come (each fails on its own); the
    /// rows are replaced only by a complete read. false when the list could not be read.
    private func reread() async -> Bool {
        let at = now()
        async let list = reader.allParcels()
        async let counts = reader.counts(now: at)
        let (readList, readCounts) = await (list, counts)
        self.counts = readCounts
        guard case let .loaded(fresh) = readList else { return false }
        rows = ParcelRules.baseOrder(fresh)
        loadState = .loaded
        return true
    }

    // MARK: 届いた

    /// Left swipe → 「届いた」 on the version shown.
    func markDelivered(id: String) async {
        guard !saving.contains(id), let row = rows.first(where: { $0.id == id }) else { return }
        saving.insert(id)
        defer { saving.remove(id) }
        rowMessages[id] = nil

        switch await writer.markDelivered(ParcelVersion(row)) {
        case let .success(token):
            apply(token)
            addToDelivered(1)
            showToast(ListToast(text: Self.savedText, canUndo: true), undo: [token])
        case .notUpdated(.conflict):
            // Changed since it was shown (a delivery mail, say): show what is there now, offer no undo.
            _ = await reread()
            if isOpen(id) { rowMessages[id] = Self.saveFailedText }
        case .notUpdated:
            rowMessages[id] = Self.saveFailedText
        case .unknown:
            // Sent, the answer lost: never send again. Read what happened.
            guard await reread() else {
                rowMessages[id] = Self.unconfirmedText
                return
            }
            if isOpen(id) {
                rowMessages[id] = Self.saveFailedText
            } else if rows.first(where: { $0.id == id })?.status == "delivered" {
                showToast(ListToast(text: Self.savedText, canUndo: false), undo: [])
            }
        }
    }

    /// 「すべて受取済にする」 on 要確認: one row at a time, each on its version shown. The toast counts
    /// only the rows written, and 「元に戻す」 puts back only those.
    func deliverAll() async {
        guard deliverAllEnabled else { return }
        isDeliveringAll = true
        defer { isDeliveringAll = false }
        deliverAllMessage = nil

        let shown = sections.toCheck
        let results = await writer.markDelivered(all: shown.map(ParcelVersion.init))
        var tokens: [UndoToken] = []
        var unsure: [String] = []
        var conflicted = false
        var failed = false
        for result in results {
            switch result.outcome {
            case let .success(token): tokens.append(token)
            case .notUpdated(.conflict): conflicted = true
            case .notUpdated: failed = true
            case .unknown: unsure.append(result.id)
            }
        }
        tokens.forEach(apply)
        addToDelivered(tokens.count)

        if conflicted || !unsure.isEmpty {
            if await reread() {
                if unsure.contains(where: isOpen) { failed = true }
            } else {
                for id in unsure { rowMessages[id] = Self.unconfirmedText }
            }
        }
        if !tokens.isEmpty {
            showToast(ListToast(text: "\(tokens.count) 件を受取済にしました", canUndo: true), undo: tokens)
        }
        if failed { deliverAllMessage = Self.deliverAllFailedText }
    }

    // MARK: 元に戻す

    /// 「元に戻す」 on the toast: each written row back to its status before, only while it is still the
    /// version 「届いた」 left (a delivery mail in between is never undone).
    func undo() async {
        guard let toast, toast.canUndo, !undoTokens.isEmpty, !isUndoing else { return }
        isUndoing = true
        defer { isUndoing = false }

        let tokens = undoTokens
        let results = await writer.undoDelivered(all: tokens)
        var restored = 0
        var conflicted = false
        var failed = false
        var unsure = false
        for result in results {
            switch result.outcome {
            case let .success(version):
                apply(version)
                restored += 1
            case .notUpdated(.conflict): conflicted = true
            case .notUpdated: failed = true
            case .unknown: unsure = true
            }
        }
        addToDelivered(-restored)

        if !conflicted && !failed && !unsure {
            hideToast()
            return
        }
        if conflicted || unsure {
            guard await reread() else {
                showToast(ListToast(text: unsure ? Self.unconfirmedText : Self.undoFailedText, canUndo: false), undo: [])
                return
            }
            // An unknown result the read shows as put back is a success.
            let allBack = tokens.allSatisfy { token in
                rows.first(where: { $0.id == token.id })?.status != "delivered"
            }
            if !conflicted && !failed && allBack {
                hideToast()
                return
            }
        }
        showToast(ListToast(text: Self.undoFailedText, canUndo: false), undo: [])
    }

    // MARK: helpers

    private func isOpen(_ id: String) -> Bool {
        sections.open.contains { $0.id == id }
    }

    private func apply(_ token: UndoToken) {
        guard let i = rows.firstIndex(where: { $0.id == token.id }) else { return }
        rows[i].status = "delivered"
        rows[i].updatedAt = token.deliveredUpdatedAt
    }

    private func apply(_ version: ParcelVersion) {
        guard let i = rows.firstIndex(where: { $0.id == version.id }) else { return }
        rows[i].status = version.status
        rows[i].updatedAt = version.updatedAt
    }

    /// Keeps 「届いた荷物 N 件」 in step with the rows written (a failed count stays failed).
    private func addToDelivered(_ n: Int) {
        guard n != 0, case let .loaded(count)? = counts?.delivered else { return }
        counts?.delivered = .loaded(max(0, count + n))
    }

    private func showToast(_ next: ListToast, undo tokens: [UndoToken]) {
        toast = next
        undoTokens = next.canUndo ? tokens : []
        toastGeneration += 1
        let generation = toastGeneration
        toastTimer?.cancel()
        toastTimer = Task { [weak self, sleep] in
            do {
                try await sleep(Self.toastDuration)
            } catch {
                return
            }
            guard let self, self.toastGeneration == generation, !self.isUndoing else { return }
            self.toast = nil
            self.undoTokens = []
        }
    }

    private func hideToast() {
        toastGeneration += 1
        toastTimer?.cancel()
        toastTimer = nil
        toast = nil
        undoTokens = []
    }
}

#if DEBUG
extension ParcelListModel {
    /// DEBUG only: shows a given state without reading, for checking the screen on the simulator.
    func debugShow(
        rows: [ParcelRow],
        counts: ParcelCounts?,
        loadState: LoadState,
        rowMessages: [String: String] = [:],
        saving: Set<String> = [],
        toast: ListToast? = nil
    ) {
        self.rows = ParcelRules.baseOrder(rows)
        self.counts = counts
        self.loadState = loadState
        self.rowMessages = rowMessages
        self.saving = saving
        self.toast = toast
    }
}
#endif
