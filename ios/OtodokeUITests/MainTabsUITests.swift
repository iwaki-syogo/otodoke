import XCTest

/// [Task 9] The tabs and the parcel list on the DEBUG screen check (`-otodoke-ui-preview`): made-up
/// parcels, no session, nothing read or written over the network.
final class MainTabsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
        app.launch()
        return app
    }

    func testEveryTabOpens() {
        let app = launch("list")
        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10))
        for title in ["カレンダー", "支出", "設定", "荷物"] {
            tabs.buttons[title].tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), title)
        }
    }

    func testTheUnreadNoticeOpensSettings() {
        let app = launch("list")
        let notice = app.buttons["まだ読んでいないメールが 3 通あります。この一覧は最新ではないかもしれません。"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        notice.tap()
        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
    }

    func testACardOpensTheDetail() {
        let app = launch("list")
        let card = app.staticTexts["架空の本 上下巻セット"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        // The detail of a parcel that cannot be read here (no session).
        XCTAssertTrue(app.staticTexts["読み込めませんでした"].firstMatch.waitForExistence(timeout: 10))
    }

    func testTheSwipeSaysItCouldNotSaveWithoutASession() {
        let app = launch("list")
        let card = app.staticTexts["架空の本 上下巻セット"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.swipeLeft()
        let arrived = app.buttons["届いた"]
        XCTAssertTrue(arrived.waitForExistence(timeout: 5))
        arrived.tap()
        XCTAssertTrue(app.staticTexts["保存できませんでした。もう一度スワイプしてください。"].waitForExistence(timeout: 10))
    }

    func testThePageLinksOpenTheirPlaces() {
        let app = launch("empty")
        let delivered = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "届いた荷物")).firstMatch
        XCTAssertTrue(delivered.waitForExistence(timeout: 10))
        delivered.tap()
        XCTAssertTrue(app.navigationBars["届いた荷物"].waitForExistence(timeout: 5))
    }

    func testDeliverAllAsksASecondTime() {
        let app = launch("list")
        let button = app.buttons["すべて受取済にする"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        XCTAssertTrue(app.buttons["1 件を受取済にする"].waitForExistence(timeout: 5))
        app.buttons["やめる"].tap()
        XCTAssertTrue(app.buttons["すべて受取済にする"].waitForExistence(timeout: 5))
    }
}
