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

    private func launch(_ scenario: String, textSize: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
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

    /// The empty list's 「サンプルで試す」 opens the settings tab's own page (not Safari), light and dark. The form that
    /// 「荷物を登録する」 (under 「これは荷物」) opens is the one the list's 「＋ 登録」 opens (shot in testTheManualForm).
    func testTheEmptyListSampleOpensTheSettingsPage() throws {
        for style in ["Light", "Dark"] {
            XCUIDevice.shared.appearance = style == "Dark" ? .dark : .light
            let app = launch("empty")
            let sample = app.buttons["サンプルで試す"].firstMatch
            XCTAssertTrue(sample.waitForExistence(timeout: 10), style)
            sample.tap()
            XCTAssertTrue(app.navigationBars["サンプルで試す"].waitForExistence(timeout: 10), style)
            XCTAssertEqual(app.state, .runningForeground)
            try shoot("empty-sample-page-\(style)")
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
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

    /// A typed-in parcel's detail with 編集, the edit form, and its delete box, light and dark; and the form at the largest text size.
    func testTheManualEditForm() throws {
        for style in ["Light", "Dark"] {
            XCUIDevice.shared.appearance = style == "Dark" ? .dark : .light
            let app = launch("detail")
            let card = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "USB-C")).firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 10), style)
            card.tap()
            XCTAssertTrue(app.buttons["編集"].waitForExistence(timeout: 10), style)
            try shoot("edit-detail-\(style)")
            app.buttons["編集"].tap()
            XCTAssertTrue(app.navigationBars["荷物を編集"].waitForExistence(timeout: 5), style)
            try shoot("edit-form-\(style)")
            for _ in 0..<3 where !app.buttons["この荷物を消す"].exists { app.swipeUp() }
            app.buttons["この荷物を消す"].tap()
            app.swipeUp()
            try shoot("edit-delete-\(style)")
            let check = app.descendants(matching: .any)["manual-delete-check"].firstMatch
            XCTAssertTrue(check.waitForExistence(timeout: 5), style)
            check.tap()
            try shoot("edit-delete-checked-\(style)")
            check.tap()
            app.buttons["消す"].tap()
            XCTAssertTrue(app.staticTexts["「本当に消す」にチェックを入れてください"].waitForExistence(timeout: 5), style)
            try shoot("edit-delete-error-\(style)")
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
        let big = launch("detail", textSize: "UICTContentSizeCategoryAccessibilityXXXL")
        let card = big.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "USB-C")).firstMatch
        _ = card.waitForExistence(timeout: 10)
        for _ in 0..<6 where !card.isHittable { big.swipeUp() }
        XCTAssertTrue(card.isHittable)
        card.tap()
        XCTAssertTrue(big.buttons["編集"].waitForExistence(timeout: 10))
        big.buttons["編集"].tap()
        XCTAssertTrue(big.navigationBars["荷物を編集"].waitForExistence(timeout: 5))
        try shoot("edit-form-biggest-text")
        big.swipeUp()
        big.swipeUp()
        try shoot("edit-form-biggest-text-2")
        big.terminate()
    }

    /// The two page links at the foot of the list (name and arrow, no number), and the two pages they open
    /// with the number by the heading, light and dark.
    func testThePageLinksAndTheirPages() throws {
        for style in ["Light", "Dark"] {
            XCUIDevice.shared.appearance = style == "Dark" ? .dark : .light
            var app = launch("bottom")
            let delivered = app.buttons["届いた荷物"]
            XCTAssertTrue(delivered.waitForExistence(timeout: 10), style)
            XCTAssertTrue(app.buttons["キャンセルした荷物"].exists, style)
            try shoot("links-\(style)")
            app.terminate()

            app = launch("delivered-page")
            XCTAssertTrue(app.staticTexts["7"].waitForExistence(timeout: 10), "the delivered page shows its number (\(style))")
            try shoot("delivered-page-\(style)")
            app.terminate()

            app = launch("cancelled-page")
            XCTAssertTrue(app.staticTexts["2"].waitForExistence(timeout: 10), "the cancelled page shows its number (\(style))")
            try shoot("cancelled-page-\(style)")
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
    }
}
