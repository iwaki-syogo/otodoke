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
    /// [B2-1] The last read was cut off (its .task cancelled): the next appearance reads again.
    @ObservationIgnored private var wasCutOff = false
    /// [B2-1, as CX-f2] The newest read's: raised as soon as its task is cancelled, before the read ends.
    @ObservationIgnored private var cutOff: CutOffSignal?
    @ObservationIgnored private var retired = false

    func clearForSignOut() {
        retired = true
        _ = fence.beginRead()
        cutOff?.raise()
        parcels = nil
        isLoading = false
    }

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
        guard !retired else { return }
        let ticket = fence.beginRead()
        let signal = CutOffSignal()
        cutOff = signal
        mark.markRead()
        isLoading = true
        let reader = self.reader
        let read = await withTaskCancellationHandler {
            await reader.parcels(.cancelled)
        } onCancel: {
            signal.raise()
        }
        // A newer read was started meanwhile: this one is older than what it would replace (and it owns
        // the state: this one being cut off changes nothing, N-new2).
        guard !retired, fence.verdict(ticket) == .current else { return }
        isLoading = false
        // [B2-1] Cut off (the .task cancelled when the tab is left): dropped, not shown as
        // 「読み込めませんでした」, and the next appearance reads again.
        guard !Task.isCancelled else {
            wasCutOff = true
            return
        }
        wasCutOff = false
        parcels = read
    }

    /// Shown: reads the first time, again when DataChanges moved since the last read, after a failed or
    /// cut-off read, and at once when the read on the way was cut off (CX-f2: not waiting for it to end).
    func onAppear() async {
        guard parcels == nil || parcels == .failed || mark.isStale || wasCutOff || cutOff?.isRaised == true else { return }
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
        .refreshableToTheEnd { await model.load() }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(CancelledModel.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.onAppear() }
    }
}

#if DEBUG
extension CancelledModel {
    /// DEBUG only: shows the given parcels without reading, for checking the screen on the simulator.
    func debugShow(parcels rows: [ParcelRow]) {
        parcels = .loaded(rows)
    }
}
#endif
