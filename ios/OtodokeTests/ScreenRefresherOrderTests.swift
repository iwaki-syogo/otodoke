import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 12, implementer's own] The orders the tabs and the navigation stacks report in:
/// a tab's appear may come before or after the old tab's disappear, a detail pops back to its tab,
/// and one parcel's detail may be open in two tabs.
/// [N-new3] By token (appeared / disappeared, the tab selected), as the app tells the refresher since N3;
/// the selection may also reach the refresher before or after the new tab's appear.
@Suite("ScreenRefresher, the orders of appear and disappear (batch 2, task 12)")
@MainActor
struct ScreenRefresherOrderTests {
    final class Counter {
        var calls: [String] = []
        var held: CheckedContinuation<Void, Never>?
        var holds = true
    }

    @Test func aTabSwitchInEitherOrder() async {
        let counter = Counter()
        let r = ScreenRefresher()
        r.select(.parcels)
        let parcels = r.appeared(.parcels, in: .parcels) { counter.calls.append("parcels") }
        // The new tab appears first, then the selection, then the old one disappears.
        let calendar = r.appeared(.calendar, in: .calendar) { counter.calls.append("calendar") }
        r.select(.calendar)
        r.disappeared(parcels)
        await r.sceneBecameActive()
        // The old one disappears first, the selection moves, then the new one appears.
        r.disappeared(calendar)
        r.select(.parcels)
        let back = r.appeared(.parcels, in: .parcels) { counter.calls.append("parcels") }
        await r.sceneBecameActive()
        #expect(counter.calls == ["calendar", "parcels"])
        r.disappeared(back)
    }

    @Test func backFromADetailTheTabIsInFrontAgain() async {
        let counter = Counter()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        r.select(.parcels)
        let root = r.appeared(.parcels, in: .parcels) { counter.calls.append("parcels") }
        let detail = r.appeared(.detail(id), in: .parcels) { counter.calls.append("detail") }
        r.disappeared(detail)
        await r.sceneBecameActive()
        #expect(counter.calls == ["parcels"])
        r.disappeared(root)
    }

    @Test func theSameDetailInTwoTabsReadsTheOneShown() async {
        let counter = Counter()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        // Open on the calendar tab.
        r.select(.calendar)
        let calendar = r.appeared(.calendar, in: .calendar) { counter.calls.append("calendar") }
        let calendarDetail = r.appeared(.detail(id), in: .calendar) { counter.calls.append("calendar's detail") }
        // To the parcels tab, where the same parcel is open too: it appears before the other goes.
        r.select(.parcels)
        let parcels = r.appeared(.parcels, in: .parcels) { counter.calls.append("parcels") }
        let parcelsDetail = r.appeared(.detail(id), in: .parcels) { counter.calls.append("parcels' detail") }
        r.disappeared(calendarDetail)
        r.disappeared(calendar)
        await r.sceneBecameActive()
        #expect(counter.calls == ["parcels' detail"])
        r.disappeared(parcelsDetail)
        r.disappeared(parcels)
    }

    @Test func aComingBackWhileReadingDoesNotReadTwice() async {
        let counter = Counter()
        let r = ScreenRefresher()
        r.select(.spend)
        let token = r.appeared(.spend, in: .spend) {
            counter.calls.append("spend")
            guard counter.holds else { return }
            await withCheckedContinuation { counter.held = $0 }
        }
        let first = Task { await r.sceneBecameActive() }
        while counter.held == nil { await Task.yield() }
        await r.sceneBecameActive()
        counter.holds = false
        counter.held?.resume()
        await first.value
        #expect(counter.calls == ["spend"])
        // Done: the next coming back reads again.
        await r.sceneBecameActive()
        #expect(counter.calls == ["spend", "spend"])
        r.disappeared(token)
    }
}
