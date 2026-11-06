// TDD-STUB(task 7) — agreed API, placeholder bodies. Remove this marker once written (the implementer
// also writes the picker view here: 「‹ 前月」, a wheel of year and month only, 「翌月 ›」).
// The months the calendar and the spend screen may show: MONTH_MIN ("2020-01") to monthMax(today).

import Foundation

struct MonthBounds: Equatable, Sendable {
    let min: String
    let max: String

    init(today: String) {
        min = ""
        max = ""
    }

    func contains(_ ym: String) -> Bool { false }

    /// `ym` moved by `delta` months stays inside.
    func canShift(_ ym: String, by delta: Int) -> Bool { false }

    /// Every month of the wheel, oldest first (min ... max).
    var months: [String] { [] }
}
