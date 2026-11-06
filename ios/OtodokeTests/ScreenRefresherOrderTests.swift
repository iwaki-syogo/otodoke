import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 12, implementer's own] The orders the tabs and the navigation stacks report in:
/// a tab's appear may come before or after the old tab's disappear, a detail pops back to its tab,
/// and one parcel's detail may be open in two tabs.
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
        r.register(.parcels) { counter.calls.append("parcels") }
        r.register(.calendar) { counter.calls.append("calendar") }
        r.shown(.parcels)
        // The new tab appears first, then the old one disappears.
        r.shown(.calendar)
        r.hidden(.parcels)
        await r.sceneBecameActive()
        // The old one disappears first.
        r.hidden(.calendar)
        r.shown(.parcels)
        await r.sceneBecameActive()
        #expect(counter.calls == ["calendar", "parcels"])
    }

    @Test func backFromADetailTheTabIsInFrontAgain() async {
        let counter = Counter()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        r.register(.parcels) { counter.calls.append("parcels") }
        r.register(.detail(id)) { counter.calls.append("detail") }
        r.shown(.parcels)
        r.shown(.detail(id))
        r.hidden(.detail(id))
        await r.sceneBecameActive()
        #expect(counter.calls == ["parcels"])
    }

    @Test func theSameDetailInTwoTabsReadsTheOneShown() async {
        let counter = Counter()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        r.register(.calendar) { counter.calls.append("calendar") }
        r.register(.parcels) { counter.calls.append("parcels") }
        // Open on the calendar tab.
        r.shown(.calendar)
        r.register(.detail(id)) { counter.calls.append("calendar's detail") }
        r.shown(.detail(id))
        // To the parcels tab, where the same parcel is open too: it appears before the other goes.
        r.shown(.parcels)
        r.register(.detail(id)) { counter.calls.append("parcels' detail") }
        r.shown(.detail(id))
        r.hidden(.detail(id))
        r.hidden(.calendar)
        await r.sceneBecameActive()
        #expect(counter.calls == ["parcels' detail"])
    }

    @Test func aComingBackWhileReadingDoesNotReadTwice() async {
        let counter = Counter()
        let r = ScreenRefresher()
        r.register(.spend) {
            counter.calls.append("spend")
            guard counter.holds else { return }
            await withCheckedContinuation { counter.held = $0 }
        }
        r.shown(.spend)
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
    }
}
