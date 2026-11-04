// TDD-STUB(task 9): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// The view model of ParcelListView (src/app/app/page.tsx + delivered-controls.tsx).

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

    init(
        reader: ParcelReader,
        writer: ParcelWriter,
        today: @escaping @Sendable () -> String,
        now: @escaping @Sendable () -> Date,
        sleep: @escaping Sleep
    ) {
        self.reader = reader
        self.writer = writer
    }

    /// ParcelRules.sections(rows, today: today()).
    var sections: ParcelSections { .empty }
    /// Loaded, and no parcel at all.
    var isEmpty: Bool { false }
    /// 「届いた荷物は、左にスワイプして「届いた」にできます」 shows when there is an open parcel.
    var showsSwipeHint: Bool { false }
    var toCheckHead: [ParcelRow] { [] }
    var toCheckRest: [ParcelRow] { [] }
    /// 「まだ読んでいないメールが N 通あります。この一覧は最新ではないかもしれません。」 when N > 0.
    var waitingNotice: String? { nil }
    /// nil when the count could not be read (the link shows without a number).
    var deliveredCount: Int? { nil }
    var cancelledCount: Int? { nil }
    /// 「すべて受取済にする」 can be pressed: something to check, and no more than ParcelWriter.maxAtOnce.
    var deliverAllEnabled: Bool { false }

    /// Reads the list and the counts (also pull to refresh).
    func load() async {}

    /// Left swipe → 「届いた」 on the version shown.
    func markDelivered(id: String) async {}

    /// 「すべて受取済にする」 on 要確認.
    func deliverAll() async {}

    /// 「元に戻す」 on the toast.
    func undo() async {}
}
