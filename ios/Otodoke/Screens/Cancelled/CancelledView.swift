// 「キャンセルした荷物」 (src/app/app/cancelled/page.tsx, 2541793): every cancelled parcel of the user, the
// heading with the number, the month groups (Delivered.groupByOrderMonth) of cards, the Web's empty and
// failure words. Back in front and 「古くなった」 read again.

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
    /// A read is on the way.
    private(set) var isLoading = false
    @ObservationIgnored let changes: DataChanges?
    @ObservationIgnored private var fence = ReadFence()
    @ObservationIgnored private let mark: ChangeMark

    init(reader: StatusListReader, changes: DataChanges?) {
        self.reader = reader
        self.changes = changes
        mark = ChangeMark(changes)
    }

    var groups: [(label: String, parcels: [ParcelRow])] {
        guard case let .loaded(rows)? = parcels else { return [] }
        return Delivered.groupByOrderMonth(rows)
    }

    /// parcels.count; nil when not read or failed.
    var count: Int? {
        parcels?.value?.count
    }

    /// 読み込めませんでした / キャンセルした荷物はありません, or nil.
    var message: String? {
        switch parcels {
        case .failed?: return Self.failedText
        case let .loaded(rows)?: return rows.isEmpty ? Self.emptyText : nil
        case nil: return nil
        }
    }

    func load() async {
        let ticket = fence.beginRead()
        mark.markRead()
        isLoading = true
        let read = await reader.parcels(.cancelled)
        // A newer read was started meanwhile: this one is older than what it would replace.
        guard fence.verdict(ticket) == .current else { return }
        parcels = read
        isLoading = false
    }

    /// Shown: reads the first time, and again when DataChanges moved since the last read.
    func onAppear() async {
        guard parcels == nil || mark.isStale else { return }
        await load()
    }

    /// iOS-12: back in front.
    func sceneBecameActive() async {
        await load()
    }
}

struct CancelledView<Detail: View>: View {
    @Bindable var model: CancelledModel
    @ViewBuilder let detail: (String) -> Detail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                StatusPageHeading(title: CancelledModel.title, count: model.count, faded: model.isLoading)
                if let message = model.message {
                    StatusPageMessage(text: message, isError: message == CancelledModel.failedText)
                } else if model.parcels == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else {
                    StatusPageGroups(groups: model.groups, today: Format.todayJst(now: Date()), detail: detail)
                        .opacity(model.isLoading ? 0.5 : 1)
                }
            }
            .padding(16)
        }
        .refreshable { await model.load() }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(CancelledModel.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.onAppear() }
    }
}
