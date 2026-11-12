import XCTest

/// [Batch 2, task 12] The calendar, spend and settings tabs open their screens (no longer the empty
/// places of batch 1). DEBUG screen check (`-otodoke-ui-preview list`; the settings tab uses `settings-signed-in`): the reads fail
/// and say 「読み込めませんでした」; nothing is read or written over the network.
final class TabsM1UITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ scenario: String = "list") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
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
        // The settings read checks the signed-in user first; this scene has one, and every read then fails.
        let app = launch("settings-signed-in")
        open(app, "設定")
        // The passphrase card at the top settles (the loading mark goes away) and says the read failed.
        XCTAssertTrue(app.staticTexts["読み込めませんでした"].firstMatch.waitForExistence(timeout: 10))
    }
}
