import XCTest

/// Real SwiftUI navigation with synthetic parcels and no account or network writes.
final class ReceivedUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
        app.launch()
        return app
    }

    private func capture(_ name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"] else { return }
        let directory = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: directory.appendingPathComponent("b14-\(name).png"))
    }

    func testDeliveredSectionAndReceivedPageUseTheirOwnLabels() throws {
        let app = launch("received-list")
        XCTAssertTrue(app.staticTexts["架空の本 上下巻セット"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["配達済み"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["🤝 対面受け取り"].exists)
        XCTAssertFalse(app.staticTexts["届いた荷物は、左にスワイプして「届いた」にできます"].exists)
        try capture("delivered-section")
        app.terminate()

        let received = launch("delivered-page")
        XCTAssertTrue(received.navigationBars["受け取り済み"].waitForExistence(timeout: 10))
        XCTAssertTrue(received.staticTexts["受け取り済み"].firstMatch.exists)
        XCTAssertFalse(received.staticTexts["🤝 対面受け取り"].exists)
        try capture("received-list")
    }

    func testDetailHasReceiptButtonsAndTheMailEvidence() throws {
        let app = launch("received-detail")
        let card = app.staticTexts["架空の本 上下巻セット"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        XCTAssertTrue(app.buttons["受け取った"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["detail.removeDelivered"].exists)
        XCTAssertFalse(app.buttons["detail.removeReceived"].exists)
        let evidence = app.staticTexts["「玄関前へのお届けが完了しました。」"]
        for _ in 0..<4 where !evidence.isHittable { app.swipeUp() }
        XCTAssertTrue(evidence.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["配達完了"].firstMatch.exists)
        XCTAssertEqual(app.state, .runningForeground)
        try capture("parcel-detail")
    }

    func testDeliveredCheckAsksForReceiptAndOffersNotYet() throws {
        let app = launch("received-check")
        XCTAssertTrue(app.staticTexts["受け取りましたか？"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["まだ"].exists)
        XCTAssertTrue(app.buttons["すべて受け取り済みにする"].exists)
        XCTAssertFalse(app.staticTexts["お届け予定から 2 週間以上たっても、届いた連絡がない荷物です。届いていますか？"].exists)
        try capture("receipt-check")
        app.buttons["すべて受け取り済みにする"].tap()
        XCTAssertTrue(app.buttons["受け取り済みにする"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["1 件を受取済にする"].exists)
        app.buttons["やめる"].tap()
        XCTAssertTrue(app.buttons["すべて受け取り済みにする"].waitForExistence(timeout: 5))
    }
}
