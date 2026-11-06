import XCTest

/// [onboarding] On the DEBUG screen check (`-otodoke-ui-preview`): the empty list's 「転送先を見る」 opens the
/// 「メールの転送」 page straight, and the waiting screen after making an account shows the wording file's words.
final class OnboardingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
        app.launch()
        return app
    }

    func testTheEmptyListsButtonOpensTheForwardingPage() {
        let app = launch("empty")
        let button = app.buttons["転送先を見る"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        XCTAssertTrue(app.navigationBars["メールの転送"].waitForExistence(timeout: 10))
    }

    func testTheSettingsTabStillOpensOnItsList() {
        let app = launch("empty")
        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10))
        tabs.buttons["設定"].tap()
        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
    }

    func testTheWaitingScreenSaysWhatToDo() {
        let app = launch("login-waiting")
        XCTAssertTrue(app.staticTexts["確認のメールを送りました"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["メールのリンクを押してこの画面に戻ると、自動で次へ進みます。"].exists)
        XCTAssertTrue(app.staticTexts["qa@example.com"].exists)
        // The preview launch brings the app to the front: no token, so nothing is sent and the button stays pressable.
        XCTAssertTrue(app.buttons["確認しました"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["メールを送り直す"].firstMatch.exists)
    }

    // MARK: the waiting screen with the real Turnstile widget and an auth that reaches nothing
    //
    // The preview's auth points at preview.invalid: a sign-in that is sent fails there with the "network" words, so
    // those words on the screen mean a try was sent. Nothing reaches Supabase. Runs only with
    // TEST_RUNNER_OTODOKE_WIDGET_CHECK=1 (it loads Cloudflare's widget over the network).

    private func widgetCheckOn() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["OTODOKE_WIDGET_CHECK"] == "1", "widget check is on request")
    }

    private let networkWords = "つながりませんでした。少し時間をおいて、もう一度お試しください。"

    func testBackFromSafariWithoutATapSendsNothingAndWaitsForTheTap() throws {
        try widgetCheckOn()
        let app = launch("login-waiting")
        XCTAssertTrue(app.buttons["確認しました"].waitForExistence(timeout: 10))
        // Away (the mail's link in Safari) and back, without touching the widget.
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        sleep(4)
        // No try was sent (no network words), no captcha words, and the button is not stuck working.
        XCTAssertFalse(app.staticTexts[networkWords].exists)
        XCTAssertFalse(app.staticTexts["確認が切れました。もう一度お試しください。"].exists)
        XCTAssertTrue(app.buttons["メールを送り直す"].isEnabled)
    }

    func testTheTapOnTheWidgetTriesAtOnceWithoutAnotherButton() throws {
        try widgetCheckOn()
        let app = launch("login-waiting")
        XCTAssertTrue(app.buttons["確認しました"].waitForExistence(timeout: 10))
        let widget = app.webViews.firstMatch
        XCTAssertTrue(widget.waitForExistence(timeout: 15))
        sleep(6)
        widget.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5)).tap()
        // The token arrives and the screen goes on by itself: the try is sent (and fails at the unreachable host).
        XCTAssertTrue(app.staticTexts[networkWords].waitForExistence(timeout: 25))
    }
}
