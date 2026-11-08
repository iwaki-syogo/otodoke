import Foundation
import Testing
@testable import Otodoke

/// The number of delivered / cancelled parcels shows beside the heading of the page the link opens,
/// written as the Web writes it (count.toLocaleString("ja-JP")); the list's link shows none.
@Suite("Status page counts")
struct StatusPageCountTests {
    @Test func theHeadingNumberIsGroupedLikeTheWeb() {
        #expect(StatusPageText.number(0) == "0")
        #expect(StatusPageText.number(7) == "7")
        #expect(StatusPageText.number(1_101) == "1,101")
        #expect(StatusPageText.number(1_234_567) == "1,234,567")
    }
}
