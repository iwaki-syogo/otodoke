// TDD-STUB(task 9): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// MainTabView (the SwiftUI view) goes in this file too, one tab per case, in this order.

import Foundation

enum MainTab: CaseIterable, Sendable {
    case parcels, calendar, spend, settings

    /// 荷物 / カレンダー / 支出 / 設定 (the Web's tab-bar).
    var title: String { "" }
}
