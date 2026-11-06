import XCTest

/// [Batch 2, task 12] The calendar, spend and settings tabs open their screens (no longer the empty
/// places of batch 1). DEBUG screen check (`-otodoke-ui-preview list`): no session, so the reads fail
/// and say 「読み込めませんでした」; nothing is read or written over the network.
final class TabsM1UITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", "list"]
        app.launch()
        return app
    }

    private func open(_ app: XCUIApplication, _ tab: String) {
        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10))
        tabs.buttons[tab].tap()
        XCTAssertTrue(app.navigationBars[tab].waitForExistence(timeout: 5), tab)
    }

    private func anything(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testTheCalendarTabShowsTheCalendar() {
        let app = launch()
        open(app, "カレンダー")
        XCTAssertTrue(anything(app, containing: "前月").waitForExistence(timeout: 5))
        XCTAssertTrue(anything(app, containing: "翌月").exists)
        XCTAssertTrue(app.staticTexts["読み込めませんでした"].firstMatch.waitForExistence(timeout: 10))
    }

    func testTheSpendTabShowsSpend() {
        let app = launch()
        open(app, "支出")
        XCTAssertTrue(anything(app, containing: "全期間").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["読み込めませんでした"].firstMatch.waitForExistence(timeout: 10))
    }

    func testTheSettingsTabShowsSettings() {
        let app = launch()
        open(app, "設定")
        // The passphrase card at the top: its read fails here, and says so.
        XCTAssertTrue(app.staticTexts["読み込めませんでした"].firstMatch.waitForExistence(timeout: 10))
    }
}
