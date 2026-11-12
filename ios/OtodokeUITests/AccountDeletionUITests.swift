import XCTest

/// Fake preview only: these tests cannot delete a real account or reach a server.
final class AccountDeletionUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testConfirmationAndCancelStayInsideTheApp() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", "account-delete"]
        app.launch()
        let open = app.buttons["account-delete-open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["account-delete-confirm"].exists)
        open.tap()
        XCTAssertTrue(app.staticTexts["アカウントを削除しますか？"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["account-delete-confirm"].exists)
        XCTAssertEqual(app.state, .runningForeground)
        if let directory = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"] {
            let dir = URL(fileURLWithPath: directory)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("b14-account-delete-confirm.png"))
        }
        app.buttons["やめる"].tap()
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["account-delete-confirm"].exists)
    }
}
