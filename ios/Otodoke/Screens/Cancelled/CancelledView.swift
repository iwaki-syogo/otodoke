// TDD-STUB(task 22): 「キャンセルした荷物」 (src/app/app/cancelled/page.tsx, 2541793): every cancelled parcel of
// the user, the heading with the number, the month groups (Delivered.groupByOrderMonth) of cards, the Web's
// empty and failure words. Back in front and 「古くなった」 read again.
// Names and signatures are the contract with StatusListsTests.

import Observation
import SwiftUI

@MainActor
@Observable
final class CancelledModel {
    static let title = "キャンセルした荷物"
    static let failedText = "読み込めませんでした"
    static let emptyText = "キャンセルした荷物はありません"

    let reader: StatusListReader
    private(set) var parcels: LoadResult<[ParcelRow]>?
    @ObservationIgnored let changes: DataChanges?

    init(reader: StatusListReader, changes: DataChanges?) {
        self.reader = reader
        self.changes = changes
    }

    var groups: [(label: String, parcels: [ParcelRow])] {
        [] // TDD-STUB(task 22)
    }

    /// parcels.count; nil when not read or failed.
    var count: Int? {
        nil // TDD-STUB(task 22)
    }

    /// 読み込めませんでした / キャンセルした荷物はありません, or nil.
    var message: String? {
        nil // TDD-STUB(task 22)
    }

    func load() async {
        // TDD-STUB(task 22)
    }

    func onAppear() async {
        // TDD-STUB(task 22)
    }

    func sceneBecameActive() async {
        // TDD-STUB(task 22)
    }
}

struct CancelledView<Detail: View>: View {
    @Bindable var model: CancelledModel
    @ViewBuilder let detail: (String) -> Detail

    var body: some View {
        EmptyView() // TDD-STUB(task 22)
    }
}
