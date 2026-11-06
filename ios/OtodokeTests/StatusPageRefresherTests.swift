import Testing
@testable import Otodoke

// [M2 merge] The delivered and cancelled pages (tasks 21, 22) tell the refresher by token, as every other
// screen since N3: a page pushed on a tab's root is 1 deep, a detail it pushes 2 deep, so the front is
// the top of the stack whatever order the appear and disappear calls come in.

@Suite("M2 merge: the delivered and cancelled pages by token")
@MainActor
struct StatusPageRefresherTests {
    final class Calls {
        var list: [String] = []
    }

    @Test func theDepths() {
        #expect(ScreenID.parcels.depth == 0)
        #expect(ScreenID.calendar.depth == 0)
        #expect(ScreenID.spend.depth == 0)
        #expect(ScreenID.settings.depth == 0)
        #expect(ScreenID.detail(Rows.id(1)).depth == 1)
        #expect(ScreenID.delivered.depth == 1)
        #expect(ScreenID.cancelled.depth == 1)
    }

    /// The page reports before its tab's root does (coming back to the tab): the page is in front.
    @Test func aPageIsInFrontOfItsTabsRootWhateverTheOrder() async {
        let calls = Calls()
        let r = ScreenRefresher()
        r.select(.parcels)
        let page = r.appeared(.cancelled, in: .parcels) { calls.list.append("cancelled") }
        let root = r.appeared(.parcels, in: .parcels) { calls.list.append("parcels") }
        await r.sceneBecameActive()
        #expect(calls.list == ["cancelled"])

        // Back on the root: the page is let go, the root is in front.
        r.disappeared(page)
        await r.sceneBecameActive()
        #expect(calls.list == ["cancelled", "parcels"])
        r.disappeared(root)
    }

    /// A detail pushed on the delivered page is 2 deep: in front even when the page reports after it.
    @Test func aDetailOnAPageIsInFrontWhateverTheOrder() async {
        let calls = Calls()
        let r = ScreenRefresher()
        r.select(.calendar)
        let root = r.appeared(.calendar, in: .calendar) { calls.list.append("calendar") }
        let detail = r.appeared(.detail(Rows.id(1)), in: .calendar, depth: 2) { calls.list.append("detail") }
        let page = r.appeared(.delivered, in: .calendar) { calls.list.append("delivered") }
        await r.sceneBecameActive()
        #expect(calls.list == ["detail"])

        // Back from the detail to the page.
        r.disappeared(detail)
        await r.sceneBecameActive()
        #expect(calls.list == ["detail", "delivered"])
        r.disappeared(page)
        r.disappeared(root)
    }

    /// Negative control: a detail left at the default depth (1) loses to the page that reports after it,
    /// which is why StatusPage hands 2 to the details it pushes.
    @Test func atTheDefaultDepthTheLaterPageWouldWin() async {
        let calls = Calls()
        let r = ScreenRefresher()
        r.select(.calendar)
        let detail = r.appeared(.detail(Rows.id(1)), in: .calendar) { calls.list.append("detail") }
        let page = r.appeared(.delivered, in: .calendar) { calls.list.append("delivered") }
        await r.sceneBecameActive()
        #expect(calls.list == ["delivered"])
        r.disappeared(detail)
        r.disappeared(page)
    }

    /// A page of another tab is not in front of the selected tab's screens.
    @Test func aPageOfAnotherTabIsNotInFront() async {
        let calls = Calls()
        let r = ScreenRefresher()
        r.select(.calendar)
        let calendar = r.appeared(.calendar, in: .calendar) { calls.list.append("calendar") }
        let page = r.appeared(.delivered, in: .parcels) { calls.list.append("parcels' delivered") }
        await r.sceneBecameActive()
        #expect(calls.list == ["calendar"])
        r.select(.parcels)
        await r.sceneBecameActive()
        #expect(calls.list == ["calendar", "parcels' delivered"])
        r.disappeared(page)
        r.disappeared(calendar)
    }
}
