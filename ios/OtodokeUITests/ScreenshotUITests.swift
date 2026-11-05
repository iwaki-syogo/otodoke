import XCTest

/// [Fix QA-1] Pictures of the real screens on the DEBUG screen check (`-otodoke-ui-preview`): a card
/// opened from the list (navigation bar and back), the category sheet, and the login screen. Runs only
/// when TEST_RUNNER_OTODOKE_SCREENSHOT_DIR is given to xcodebuild; writes PNGs there, named with
/// TEST_RUNNER_OTODOKE_SCREENSHOT_PREFIX (default "fix1-").
final class ScreenshotUITests: XCTestCase {
    private var directory: URL?
    private var prefix = "fix1-"

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        directory = env["OTODOKE_SCREENSHOT_DIR"].map { URL(fileURLWithPath: $0) }
        prefix = env["OTODOKE_SCREENSHOT_PREFIX"] ?? "fix1-"
        try XCTSkipIf(directory == nil, "screenshots only on request")
    }

    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
        app.launch()
        return app
    }

    private func shoot(_ name: String) throws {
        let dir = try XCTUnwrap(directory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Let animations settle.
        Thread.sleep(forTimeInterval: 0.8)
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("\(prefix)\(name).png"))
    }

    func testTheDetailOpenedFromTheList() throws {
        let app = launch("detail")
        let card = app.staticTexts["架空の本 上下巻セット"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        try shoot("list")
        card.tap()
        XCTAssertTrue(app.staticTexts["お届け予定"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 5))
        try shoot("detail-nav")

        let chip = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "分類:")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        chip.tap()
        XCTAssertTrue(app.buttons["閉じる"].waitForExistence(timeout: 5))
        try shoot("category-sheet")
        app.buttons["閉じる"].tap()

        app.swipeUp()
        try shoot("detail-scrolled")

        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["架空の本 上下巻セット"].waitForExistence(timeout: 10))
        try shoot("detail-back")
    }

    func testTheLoginScreens() throws {
        for scenario in ["login", "login-code", "login-error"] {
            let app = launch(scenario)
            XCTAssertTrue(app.staticTexts["ログイン"].waitForExistence(timeout: 10), scenario)
            try shoot(scenario)
            app.terminate()
        }
    }
}
