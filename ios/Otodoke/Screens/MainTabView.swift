// The tabs after sign-in, in the order and with the names of the Web's tab-bar:
// 荷物 / カレンダー / 支出 / 設定. カレンダー, 支出 and 設定 are empty places for the second batch.

import SwiftUI

enum MainTab: CaseIterable, Hashable, Sendable {
    case parcels, calendar, spend, settings

    /// 荷物 / カレンダー / 支出 / 設定 (the Web's tab-bar).
    var title: String {
        switch self {
        case .parcels: "荷物"
        case .calendar: "カレンダー"
        case .spend: "支出"
        case .settings: "設定"
        }
    }

    /// The SF Symbol closest to the Web's icon.
    var systemImage: String {
        switch self {
        case .parcels: "shippingbox"
        case .calendar: "calendar"
        case .spend: "yensign"
        case .settings: "slider.horizontal.3"
        }
    }
}

struct MainTabView: View {
    @State private var selection: MainTab = .parcels
    @State private var listModel: ParcelListModel
    /// The detail's model for an id, when made elsewhere (the DEBUG screen check).
    private let detailModel: ((String) -> ParcelDetailModel)?

    init(reader: ParcelReader, writer: ParcelWriter) {
        _listModel = State(initialValue: .live(reader: reader, writer: writer))
        detailModel = nil
    }

    /// With models made elsewhere (the DEBUG screen check).
    init(listModel: ParcelListModel, detailModel: ((String) -> ParcelDetailModel)? = nil) {
        _listModel = State(initialValue: listModel)
        self.detailModel = detailModel
    }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(MainTab.allCases, id: \.self) { tab in
                screen(tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
    }

    @ViewBuilder
    private func screen(_ tab: MainTab) -> some View {
        switch tab {
        case .parcels:
            ParcelListView(model: listModel, openSettings: { selection = .settings }) { id in
                if let detailModel {
                    ParcelDetailView(model: detailModel(id))
                } else {
                    ParcelDetailView(id: id, reader: listModel.reader, writer: listModel.writer)
                }
            }
        case .calendar, .spend, .settings:
            NavigationStack {
                PlaceholderScreen(title: tab.title)
            }
        }
    }
}
