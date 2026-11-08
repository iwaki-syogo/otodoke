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

/// 「保存中… 12/80」 while 「すべて受取済にする」 is sent one row at a time.
struct BulkProgress: Equatable, Sendable {
    let done: Int
    let total: Int
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

    /// Under 「N 件を受取済にしました」 when some of them were saved with an unknown answer (Codex-P3):
    /// 「元に戻す」 cannot put those back.
    static func cannotUndoNote(_ n: Int) -> String { "\(n) 件は元に戻せません" }
    /// After 「元に戻す」 on such a toast: the rows put back, and the rows left delivered.
    static func undoneButKeptText(restored: Int, kept: Int) -> String {
        "\(restored) 件を元に戻しました。\(kept) 件は受取済のままです"
    }

    enum LoadState: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed
    }

    /// What became of a read of the list.
    private enum ReadOutcome: Equatable {
        /// Shown.
        case applied
        /// The list could not be read.
        case failed
        /// A newer read was started: its answer is the one to show.
        case superseded
        /// A write started or finished while it was read, so it may show the row from before the
        /// write: not shown. Another read follows (at once, or when the writes in flight are done).
        case stale
    }

    let reader: ParcelReader
    let writer: ParcelWriter
    /// What has come in so far, read only when the list comes back empty (nil: not read, as in the tests).
    @ObservationIgnored private let readMail: (@Sendable () async -> MailSoFar?)?

    private(set) var loadState: LoadState = .idle
    /// Which of the empty list's three guides to show. A list with parcels, or a mail read that failed before any
    /// read worked, is .none; a failed read again keeps the guide shown.
    private(set) var mailSoFar: MailSoFar = .none
    /// The mail was read once for the list as it is now empty (what mailSoFar shows is that answer, not a guess).
    @ObservationIgnored private var mailKnown = false
    /// The parcels in ParcelRules.baseOrder.
    private(set) var rows: [ParcelRow] = []
    /// nil until the first load.
    private(set) var counts: ParcelCounts?
    /// Ids whose 「届いた」 is being saved (保存中…).
    private(set) var saving: Set<String> = []
    /// Ids being read again after an unknown result (「確かめる」): 確認中…, nothing is sent.
    private(set) var checking: Set<String> = []
    /// Per-card messages: 保存できませんでした。もう一度スワイプしてください。 / 確かめられませんでした
    private(set) var rowMessages: [String: String] = [:]
    /// Ids whose last write has an unknown result that no read has settled yet (Codex-P3). Nothing is
    /// written to them (swipe, 「すべて受取済にする」, 「元に戻す」) until a read of the list shows them:
    /// a swipe on one only reads the list again.
    private(set) var unconfirmed: Set<String> = []
    private(set) var toast: ListToast?
    /// A second line of the toast: 「1 件は元に戻せません」.
    private(set) var toastNote: String?
    /// Bumped by every new toast, so an older timer or an older 「元に戻す」 never touches a newer toast.
    private(set) var toastGeneration = 0
    /// The toasts (by generation) whose 「元に戻す」 is being sent.
    private(set) var undoingGenerations: Set<Int> = []
    private(set) var isDeliveringAll = false
    /// How far 「すべて受取済にする」 has got.
    private(set) var deliverAllProgress: BulkProgress?
    /// Under 「すべて受取済にする」 when some of them could not be saved.
    private(set) var deliverAllMessage: String?
    /// A read again (pull to refresh, back from a detail, after a write) failed: the list shown is
    /// kept, with 「読み込めませんでした」 above it.
    private(set) var refreshFailed = false

    @ObservationIgnored private let today: @Sendable () -> String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let sleep: Sleep
    /// What 「元に戻す」 on the current toast puts back: only the rows that were written.
    @ObservationIgnored private var undoTokens: [UndoToken] = []
    /// How many rows the current toast counts that 「元に戻す」 does not put back.
    @ObservationIgnored private var undoKeeps = 0
    @ObservationIgnored private var toastTimer: Task<Void, Never>?

    /// Each read of the list gets a number; only the newest one is shown.
    @ObservationIgnored private var readNumber = 0
    @ObservationIgnored private var latestRead: Task<ReadOutcome, Never>?
    /// Bumped when a write is sent and when it is answered: a read that saw it change is not shown.
    @ObservationIgnored private var writeGeneration = 0
    @ObservationIgnored private var writesInFlight = 0
    /// A read was not shown because of a write in flight: read again when the writes are done.
    @ObservationIgnored private var readAfterWrites = false

    /// sections, kept until the rows or the day change.
    @ObservationIgnored private var rowsVersion = 0
    @ObservationIgnored private var sectionsCache: (version: Int, today: String, value: ParcelSections)?

    init(
        reader: ParcelReader,
        writer: ParcelWriter,
        today: @escaping @Sendable () -> String,
        now: @escaping @Sendable () -> Date,
        sleep: @escaping Sleep,
        readMail: (@Sendable () async -> MailSoFar?)? = nil
    ) {
        self.readMail = readMail
        self.reader = reader
        self.writer = writer
        self.today = today
        self.now = now
        self.sleep = sleep
    }

    /// The app's model: the device clock, JST days and real sleeps.
    static func live(reader: ParcelReader, writer: ParcelWriter, readMail: (@Sendable () async -> MailSoFar?)? = nil) -> ParcelListModel {
        ParcelListModel(
            reader: reader,
            writer: writer,
            today: { Format.todayJst(now: Date()) },
            now: { Date() },
            sleep: { try await Task.sleep(for: $0) },
            readMail: readMail
        )
    }

    /// 「古くなった」 from the other tabs (CX1). Set by MainTabView; `onAppear()` reads again when it
    /// moved since this screen's last read.
    @ObservationIgnored var changes: DataChanges? {
        didSet { mark = ChangeMark(changes) }
    }
    @ObservationIgnored private var mark = ChangeMark(nil)

    /// Shown (the tab opened): reads the first time, and again when DataChanges moved since the last
    /// read (and does nothing otherwise).
    func onAppear() async {
        if loadState == .idle || mark.isStale { await load() }
    }

    /// Today (YYYY-MM-DD, JST), for the cards.
    var todayJst: String { today() }

    /// ParcelRules.sections(rows, today: today()), worked out once per change of the rows or the day.
    var sections: ParcelSections {
        let rows = self.rows
        let day = today()
        if let cache = sectionsCache, cache.version == rowsVersion, cache.today == day { return cache.value }
        let value = ParcelRules.sections(rows, today: day)
        sectionsCache = (rowsVersion, day, value)
        return value
    }
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
    /// 「すべて受取済にする」 can be pressed: something to check, and no more than ParcelWriter.maxAtOnce.
    var deliverAllEnabled: Bool {
        let n = sections.toCheck.count
        return n > 0 && n <= ParcelWriter.maxAtOnce && !isDeliveringAll
    }
    /// 「元に戻す」 of the toast shown is being sent (「戻しています…」).
    var isUndoing: Bool { undoingGenerations.contains(toastGeneration) }
    /// 「保存中… 12/80」 (「保存中…」 before the first answer).
    var deliverAllProgressText: String {
        guard let p = deliverAllProgress, p.total > 1 else { return "保存中…" }
        return "保存中… \(p.done)/\(p.total)"
    }

    // MARK: reading

    /// Reads the list and the counts (also pull to refresh). A failed first read is
    /// 「読み込めませんでした」, never an empty list; a failed read again keeps the list shown and says
    /// 「読み込めませんでした」 above it. The counts show on their own either way.
    func load() async {
        if loadState == .idle { loadState = .loading }
        switch await reread() {
        case .applied:
            refreshFailed = false
            rowMessages = rowMessages.filter { saving.contains($0.key) || unconfirmed.contains($0.key) }
            deliverAllMessage = nil
        case .failed:
            if loadState != .loaded {
                rows = []
                rowsVersion &+= 1
                loadState = .failed
            }
        case .stale, .superseded:
            // A write is in flight: the list is read again when it is done.
            break
        }
    }

    /// Back on the list from a parcel's detail, where 「届いていない」 or the category may have
    /// changed it: the list is read again (kept on screen while it is read).
    func returnedFromDetail() async {
        await load()
    }

    /// Reads the list and the counts and shows them, unless a newer read or a write overlapped it.
    /// Follows the newest read to its end; reads again when a write overlapped (at most twice here,
    /// and once more after the writes in flight are done).
    private func reread() async -> ReadOutcome {
        var task = startRead()
        var retries = 0
        while true {
            switch await task.value {
            case .applied: return .applied
            case .failed: return .failed
            case .superseded:
                guard let latest = latestRead, latest != task else { return .stale }
                task = latest
            case .stale:
                if writesInFlight > 0 {
                    readAfterWrites = true
                    return .stale
                }
                retries += 1
                guard retries <= 2 else {
                    readAfterWrites = true
                    return .stale
                }
                task = startRead()
            }
        }
    }

    private func startRead() -> Task<ReadOutcome, Never> {
        mark.markRead()
        readNumber += 1
        let number = readNumber
        let generation = writeGeneration
        let at = now()
        let reader = self.reader
        let readMail = self.readMail
        let task = Task { [weak self] () -> ReadOutcome in
            async let list = reader.allParcels()
            async let counts = reader.counts(now: at)
            let (readList, readCounts) = await (list, counts)
            // Only an empty list needs to know what has come in (the Web reads it for the empty list only).
            var mail: MailSoFar?
            if case let .loaded(fresh) = readList, fresh.isEmpty, let readMail { mail = await readMail() }
            guard let self else { return .failed }
            return self.finishRead(number: number, generation: generation, list: readList, counts: readCounts, mail: mail)
        }
        latestRead = task
        return task
    }

    /// The counts are taken as they come (each fails on its own); the rows are replaced only by a
    /// complete read. Settles every unconfirmed id: the list now shows what happened to it.
    private func finishRead(number: Int, generation: Int, list: LoadResult<[ParcelRow]>, counts: ParcelCounts, mail: MailSoFar? = nil) -> ReadOutcome {
        guard number == readNumber else { return .superseded }
        guard generation == writeGeneration, writesInFlight == 0 else { return .stale }
        self.counts = counts
        guard case let .loaded(fresh) = list else {
            if loadState == .loaded { refreshFailed = true }
            return .failed
        }
        rows = ParcelRules.baseOrder(fresh)
        rowsVersion &+= 1
        // A read of the mail that failed (nil) keeps the guide already shown; only a first read answers none.
        if !fresh.isEmpty {
            mailSoFar = .none
            mailKnown = false
        } else if let mail {
            mailSoFar = mail
            mailKnown = true
        } else if !mailKnown {
            mailSoFar = .none
        }
        loadState = .loaded
        refreshFailed = false
        for id in unconfirmed where rowMessages[id] == Self.unconfirmedText {
            rowMessages[id] = nil
        }
        unconfirmed.removeAll()
        return .applied
    }

    private func beginWrite() {
        writesInFlight += 1
        writeGeneration &+= 1
    }

    private func endWrite() {
        writesInFlight -= 1
        writeGeneration &+= 1
        if writesInFlight == 0, readAfterWrites {
            readAfterWrites = false
            Task { [weak self] in _ = await self?.reread() }
        }
    }

    // MARK: 届いた

    /// Left swipe → 「届いた」 on the version shown. On a parcel whose last write is not known yet,
    /// only reads the list again (never sends again).
    func markDelivered(id: String) async {
        guard !saving.contains(id), let row = rows.first(where: { $0.id == id }) else { return }
        saving.insert(id)
        defer { saving.remove(id) }

        if unconfirmed.contains(id) {
            checking.insert(id)
            defer { checking.remove(id) }
            if await reread() != .applied, unconfirmed.contains(id) {
                rowMessages[id] = Self.unconfirmedText
            }
            return
        }

        rowMessages[id] = nil
        beginWrite()
        let result = await writer.markDelivered(ParcelVersion(row))
        endWrite()

        switch result {
        case let .success(token):
            apply(token)
            showToast(ListToast(text: Self.savedText, canUndo: true), undo: [token])
        case .notUpdated(.conflict):
            // Changed since it was shown (a delivery mail, say): show what is there now, offer no undo.
            _ = await reread()
            if isOpen(id) { rowMessages[id] = Self.saveFailedText }
        case .notUpdated:
            rowMessages[id] = Self.saveFailedText
        case .unknown:
            // Sent, the answer lost: never send again. Read what happened.
            unconfirmed.insert(id)
            guard await reread() == .applied else {
                if unconfirmed.contains(id) { rowMessages[id] = Self.unconfirmedText }
                return
            }
            if isOpen(id) {
                rowMessages[id] = Self.saveFailedText
            } else if rows.first(where: { $0.id == id })?.status == "delivered" {
                showToast(ListToast(text: Self.savedText, canUndo: false), undo: [])
            }
        }
    }

    /// 「すべて受取済にする」 on 要確認: one row at a time, each on its version shown, with
    /// 「保存中… n/N」. The toast counts the rows now delivered by it (an unknown result that the read
    /// shows delivered included), and 「元に戻す」 puts back only the rows whose write was answered.
    /// Rows being swiped, or not yet confirmed, are not sent. The rows it sends are held as being saved
    /// from before the first is sent until their results are shown and read again (CF2): a swipe,
    /// 「確かめる」 or 「元に戻す」 on one of them sends nothing meanwhile.
    func deliverAll() async {
        guard deliverAllEnabled else { return }
        isDeliveringAll = true
        defer {
            isDeliveringAll = false
            deliverAllProgress = nil
        }
        deliverAllMessage = nil

        let toCheck = sections.toCheck
        let skipped = toCheck.filter { unconfirmed.contains($0.id) }.map(\.id)
        let shown = toCheck.filter { !unconfirmed.contains($0.id) && !saving.contains($0.id) }
        let held = Set(shown.map(\.id))
        saving.formUnion(held)
        defer { saving.subtract(held) }
        deliverAllProgress = BulkProgress(done: 0, total: shown.count)
        beginWrite()
        let results = await writer.markDelivered(all: shown.map(ParcelVersion.init)) { [weak self] done in
            await self?.setDeliverAllProgress(done: done, total: shown.count)
        }
        endWrite()

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
        unconfirmed.formUnion(unsure)

        var confirmed = 0
        if conflicted || !unsure.isEmpty || !skipped.isEmpty {
            if await reread() == .applied {
                for id in unsure {
                    if isOpen(id) {
                        failed = true
                    } else if rows.first(where: { $0.id == id })?.status == "delivered" {
                        confirmed += 1
                    }
                }
            } else {
                for id in unsure where unconfirmed.contains(id) { rowMessages[id] = Self.unconfirmedText }
            }
        }
        let written = tokens.count + confirmed
        if written > 0 {
            // R1: the rows whose answer was lost are counted, but 「元に戻す」 cannot put them back.
            let canUndo = !tokens.isEmpty
            showToast(
                ListToast(text: "\(written) 件を受取済にしました", canUndo: canUndo),
                undo: tokens,
                note: canUndo && confirmed > 0 ? Self.cannotUndoNote(confirmed) : nil,
                keeps: canUndo ? confirmed : 0
            )
        }
        if failed { deliverAllMessage = Self.deliverAllFailedText }
    }

    private func setDeliverAllProgress(done: Int, total: Int) {
        guard isDeliveringAll else { return }
        deliverAllProgress = BulkProgress(done: done, total: total)
    }

    // MARK: 元に戻す

    /// 「元に戻す」 on the toast: each written row back to its status before, only while it is still the
    /// version 「届いた」 left (a delivery mail in between is never undone). When it is done, only the
    /// toast it was pressed on is changed: a newer toast (another swipe meanwhile) and its 「元に戻す」
    /// stay as they are.
    func undo() async {
        guard let toast, toast.canUndo, !undoTokens.isEmpty, !isUndoing,
              !undoTokens.contains(where: { saving.contains($0.id) })
        else { return }
        let generation = toastGeneration
        undoingGenerations.insert(generation)
        defer { undoingGenerations.remove(generation) }

        let tokens = undoTokens
        let keeps = undoKeeps
        // Not known yet (rare): not sent; the read below tells.
        let blocked = tokens.filter { unconfirmed.contains($0.id) }.map(\.id)
        let sendable = tokens.filter { !unconfirmed.contains($0.id) }
        beginWrite()
        let results = await writer.undoDelivered(all: sendable)
        endWrite()

        var restored = 0
        var notBack: [String] = []
        var unsure: [String] = []
        var conflicted = false
        for result in results {
            switch result.outcome {
            case let .success(version):
                apply(version)
                restored += 1
            case .notUpdated(.conflict):
                conflicted = true
                notBack.append(result.id)
            case .notUpdated:
                notBack.append(result.id)
            case .unknown:
                unsure.append(result.id)
            }
        }
        unconfirmed.formUnion(unsure)

        enum Outcome { case done, failed, unconfirmed }
        let outcome: Outcome
        if notBack.isEmpty && unsure.isEmpty && blocked.isEmpty {
            outcome = .done
        } else if conflicted || !unsure.isEmpty || !blocked.isEmpty {
            if await reread() == .applied {
                // An unknown result the read shows as put back is a success.
                let allBack = tokens.allSatisfy { token in
                    rows.first(where: { $0.id == token.id })?.status != "delivered"
                }
                outcome = notBack.isEmpty && allBack ? .done : .failed
            } else {
                outcome = unsure.isEmpty && blocked.isEmpty ? .failed : .unconfirmed
            }
        } else {
            outcome = .failed
        }

        guard toastGeneration == generation else {
            // A newer toast is up: leave it and its 「元に戻す」 alone; say it on the cards.
            for id in notBack { rowMessages[id] = Self.undoFailedText }
            for id in unsure + blocked where unconfirmed.contains(id) { rowMessages[id] = Self.unconfirmedText }
            return
        }
        switch outcome {
        case .done:
            if keeps > 0 {
                // R1: say that some stay delivered, rather than hide the toast as if all went back.
                showToast(ListToast(text: Self.undoneButKeptText(restored: tokens.count, kept: keeps), canUndo: false), undo: [])
            } else {
                hideToast()
            }
        case .failed: showToast(ListToast(text: Self.undoFailedText, canUndo: false), undo: [])
        case .unconfirmed: showToast(ListToast(text: Self.unconfirmedText, canUndo: false), undo: [])
        }
    }

    // MARK: helpers

    private func isOpen(_ id: String) -> Bool {
        sections.open.contains { $0.id == id }
    }

    private func apply(_ token: UndoToken) {
        guard let i = rows.firstIndex(where: { $0.id == token.id }) else { return }
        rows[i].status = "delivered"
        rows[i].updatedAt = token.deliveredUpdatedAt
        rowsVersion &+= 1
    }

    private func apply(_ version: ParcelVersion) {
        guard let i = rows.firstIndex(where: { $0.id == version.id }) else { return }
        rows[i].status = version.status
        rows[i].updatedAt = version.updatedAt
        rowsVersion &+= 1
    }

    private func showToast(_ next: ListToast, undo tokens: [UndoToken], note: String? = nil, keeps: Int = 0) {
        toast = next
        toastNote = note
        undoTokens = next.canUndo ? tokens : []
        undoKeeps = next.canUndo ? keeps : 0
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
            self.toastNote = nil
            self.undoTokens = []
            self.undoKeeps = 0
        }
    }

    private func hideToast() {
        toastGeneration += 1
        toastTimer?.cancel()
        toastTimer = nil
        toast = nil
        toastNote = nil
        undoTokens = []
        undoKeeps = 0
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
        checking: Set<String> = [],
        toast: ListToast? = nil,
        toastNote: String? = nil,
        mailSoFar: MailSoFar = .none
    ) {
        self.mailSoFar = mailSoFar
        self.rows = ParcelRules.baseOrder(rows)
        rowsVersion &+= 1
        self.counts = counts
        self.loadState = loadState
        self.rowMessages = rowMessages
        self.saving = saving
        self.checking = checking
        self.toast = toast
        self.toastNote = toastNote
    }
}
#endif
