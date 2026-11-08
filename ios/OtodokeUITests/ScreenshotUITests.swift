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

        let chip = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "分類を変える")).firstMatch
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

    /// [Fix 2] The 要確認 box with its border (closed and opened), 「確認中…」 and the toast's second line.
    func testTheCheckBoxAndTheToastNote() throws {
        let app = launch("many")
        let more = app.buttons["ほか 4 件を見る"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        try shoot("check-box")
        more.tap()
        try shoot("check-box-open")
        app.terminate()

        let checking = launch("checking")
        let labelled = { (text: String) in
            checking.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        XCTAssertTrue(labelled("確認中…").waitForExistence(timeout: 10))
        XCTAssertTrue(labelled("1 件は元に戻せません").waitForExistence(timeout: 5))
        try shoot("checking-toast-note")
    }

    /// The first screen, and the form each of its two buttons opens, in light and dark.
    func testTheWelcomeScreen() throws {
        for style in ["Light", "Dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-otodoke-ui-preview", "welcome", "-AppleInterfaceStyle", style]
            app.launch()
            XCTAssertTrue(app.buttons["welcome.signUp"].waitForExistence(timeout: 10), style)
            XCTAssertTrue(app.buttons["welcome.signIn"].exists, style)
            try shoot("welcome-\(style)")
            app.buttons["welcome.signUp"].tap()
            XCTAssertTrue(app.secureTextFields["パスワード（もう一度）"].waitForExistence(timeout: 10), style)
            try shoot("welcome-signup-\(style)")
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 10), "back to the first screen")
            app.buttons["welcome.signIn"].tap()
            XCTAssertTrue(app.secureTextFields["パスワード"].waitForExistence(timeout: 10), style)
            XCTAssertFalse(app.secureTextFields["パスワード（もう一度）"].exists)
            try shoot("welcome-signin-\(style)")
            app.terminate()
        }
    }

    /// The empty list's three guides, light and dark.
    func testTheEmptyListGuides() throws {
        for scenario in ["empty", "empty-received", "empty-approval"] {
            for style in ["Light", "Dark"] {
                // The launch argument -AppleInterfaceStyle does not reach the app here: set the device's appearance.
                XCUIDevice.shared.appearance = style == "Dark" ? .dark : .light
                let app = launch(scenario)
                XCTAssertTrue(app.staticTexts["まだ荷物がありません"].waitForExistence(timeout: 10), scenario)
                try shoot("\(scenario)-\(style)")
                app.terminate()
            }
            XCUIDevice.shared.appearance = .light
        }
    }

    func testTheLoginScreens() throws {
        for scenario in ["login", "login-signup", "login-error", "login-sent"] {
            let app = launch(scenario)
            let title = scenario == "login-signup" || scenario == "login-sent" ? "アカウントを作る" : "ログイン"
            XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 10), scenario)
            try shoot(scenario)
            app.terminate()
        }
    }

    /// 「＋ 登録」: the empty form, a form being filled in, and the form with an error, light and dark.
    func testTheManualForm() throws {
        for style in ["Light", "Dark"] {
            XCUIDevice.shared.appearance = style == "Dark" ? .dark : .light
            let app = launch("list")
            let add = app.buttons["＋ 登録"]
            XCTAssertTrue(add.waitForExistence(timeout: 10), style)
            add.tap()
            XCTAssertTrue(app.navigationBars["荷物を登録"].waitForExistence(timeout: 5), style)
            try shoot("manual-empty-\(style)")
            app.textFields["品名"].tap()
            app.textFields["品名"].typeText("架空の本 上下巻セット")
            try shoot("manual-typing-\(style)")
            app.swipeUp()
            app.swipeUp()
            try shoot("manual-bottom-\(style)")
            app.buttons["登録"].tap()
            XCTAssertTrue(app.staticTexts["店を入れてください"].waitForExistence(timeout: 5), style)
            try shoot("manual-error-\(style)")
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
    }
}
