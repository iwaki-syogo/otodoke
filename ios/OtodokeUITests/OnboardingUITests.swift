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
        // The preview launch itself brings the app to the front, which tries once (the buttons wait, disabled, meanwhile).
        XCTAssertTrue(app.staticTexts["確認しました"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["メールを送り直す"].firstMatch.exists)
    }
}
