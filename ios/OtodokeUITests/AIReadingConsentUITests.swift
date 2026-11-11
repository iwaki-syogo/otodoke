import XCTest

/// The real consent and settings screens, backed by the DEBUG consent server and made-up mail.
@MainActor
final class AIReadingConsentUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario]
        app.launch()
        return app
    }

    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        let exists = element.waitForExistence(timeout: 10)
        if !exists { saveDiagnostics("tap-missing", in: app) }
        XCTAssertTrue(exists)
        for _ in 0..<8 where !element.isHittable { app.swipeUp() }
        let hittable = element.isHittable
        if !hittable { saveDiagnostics("tap-not-hittable", in: app) }
        XCTAssertTrue(hittable)
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        wait(for: [enabled], timeout: 10)
        element.tap()
    }

    private func settingsPage(_ title: String, in app: XCUIApplication) {
        tap(app.tabBars.buttons["設定"], in: app)
        let root = app.navigationBars["設定"]
        // Each tab keeps its navigation path, including the sample page left by a successful load.
        if !root.exists {
            let back = app.navigationBars.buttons["設定"]
            if back.waitForExistence(timeout: 2) { tap(back, in: app) }
        }
        let rootShown = root.waitForExistence(timeout: 10)
        if !rootShown { saveDiagnostics("settings-root-missing", in: app) }
        XCTAssertTrue(rootShown)
        // Match the row's exact title child, not a substring shared with a different action.
        tap(app.buttons.containing(.staticText, identifier: title).firstMatch, in: app)
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
    }

    private func saveDiagnostics(_ name: String, in app: XCUIApplication) {
        let safeName = name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
        let stem = "b14-ai-reading-\(safeName)-\(UUID().uuidString)"
        let screenshot = app.screenshot()
        let hierarchy = app.debugDescription
        XCTContext.runActivity(named: stem) { activity in
            let picture = XCTAttachment(screenshot: screenshot)
            picture.lifetime = .keepAlways
            activity.add(picture)
            let tree = XCTAttachment(string: hierarchy)
            tree.lifetime = .keepAlways
            activity.add(tree)
            guard let path = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"] else { return }
            do {
                let directory = URL(fileURLWithPath: path)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try screenshot.pngRepresentation.write(to: directory.appendingPathComponent(stem + ".png"))
                try hierarchy.write(to: directory.appendingPathComponent(stem + ".txt"), atomically: true, encoding: .utf8)
            } catch {
                let failure = XCTAttachment(string: "Diagnostic export failed: \(error)")
                failure.lifetime = .keepAlways
                activity.add(failure)
            }
        }
    }

    private func forwardingControl(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func assertForwardingHidden(in app: XCUIApplication, address: String? = nil) {
        for identifier in ["forwarding-address", "forwarding-copy", "forwarding-approval"] {
            XCTAssertFalse(forwardingControl(identifier, in: app).exists, identifier)
        }
        XCTAssertFalse(app.buttons["承認ページを開く"].exists)
        if let address { XCTAssertFalse(app.staticTexts[address].exists) }
    }

    private func assertConsentSaveCount(_ count: Int, in app: XCUIApplication) {
        let counter = app.descendants(matching: .any).matching(identifier: "consent-preview.save-count").firstMatch
        XCTAssertTrue(counter.waitForExistence(timeout: 10))
        XCTAssertEqual(counter.value as? String, String(count))
    }

    private func assertAutoReadCount(_ count: Int, in app: XCUIApplication) {
        // This counter belongs to the Fake API's afterConsent overload, not to a saved choice.
        assertAPICallCount(count, identifier: "consent-preview.auto-read-count", in: app)
    }

    private func assertManualReadCount(_ count: Int, in app: XCUIApplication) {
        assertAPICallCount(count, identifier: "consent-preview.manual-read-count", in: app)
    }

    private func assertAPICallCount(_ count: Int, identifier: String, in app: XCUIApplication) {
        let counter = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        XCTAssertTrue(counter.waitForExistence(timeout: 10))
        let value = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", String(count)), object: counter)
        wait(for: [value], timeout: 10)
        XCTAssertEqual(counter.value as? String, String(count))
    }

    private func assertAutomaticParcelIsVisible(in app: XCUIApplication) {
        tap(app.tabBars.buttons["荷物"], in: app)
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        // Only the waiting-mail Fake produces this parcel; loading the saved sample cannot satisfy it.
        XCTAssertTrue(app.staticTexts["架空の自動読取の本"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["架空の本 上下巻セット"].exists)
        assertAutoReadCount(1, in: app)
    }

    func testUndecidedPromptShowsTheAgreedCopyAndSavesAScreenshot() throws {
        let app = launch("consent-required")
        let title = app.staticTexts["ai-reading-consent.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.label, "メールの読み取り")
        XCTAssertTrue(app.staticTexts["届いたメールは、Anthropic の Claude で読み取ります。"].exists)
        XCTAssertTrue(app.buttons["ai-reading-consent.allow"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["ai-reading-consent.deny"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["ai-reading-consent.allow"].label, "許可する")
        XCTAssertEqual(app.buttons["ai-reading-consent.deny"].label, "許可しない")
        XCTAssertEqual(app.buttons["ai-reading-consent.privacy"].label, "プライバシーポリシー")
        assertForwardingHidden(in: app)
        assertAutoReadCount(0, in: app)
        if let path = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: directory.appendingPathComponent("b14-ai-reading-consent.png"))
        }
    }

    func testAllowingAndDecliningControlTheSameForwardingDetails() {
        let allowed = launch("consent-required")
        XCTAssertFalse(allowed.staticTexts["架空の自動読取の本"].exists)
        tap(allowed.buttons["ai-reading-consent.allow"], in: allowed)
        XCTAssertTrue(allowed.staticTexts["ai-reading-consent.title"].waitForNonExistence(timeout: 10))
        assertConsentSaveCount(1, in: allowed)
        // The single allow press reads the backlog. No separate read button is pressed.
        assertAutomaticParcelIsVisible(in: allowed)
        settingsPage("メールの転送", in: allowed)
        let address = forwardingControl("forwarding-address", in: allowed)
        XCTAssertTrue(address.waitForExistence(timeout: 10), "the allowed control must contain an address")
        XCTAssertFalse(address.label.isEmpty)
        XCTAssertTrue(address.label.contains("@"))
        let addressText = address.label
        XCTAssertTrue(forwardingControl("forwarding-copy", in: allowed).waitForExistence(timeout: 10))
        XCTAssertTrue(forwardingControl("forwarding-approval", in: allowed).waitForExistence(timeout: 10))
        allowed.terminate()

        let denied = launch("consent-required")
        tap(denied.buttons["ai-reading-consent.deny"], in: denied)
        XCTAssertTrue(denied.staticTexts["ai-reading-consent.title"].waitForNonExistence(timeout: 10))
        assertConsentSaveCount(1, in: denied)
        settingsPage("メールの転送", in: denied)
        assertForwardingHidden(in: denied, address: addressText)
        assertAutoReadCount(0, in: denied)
        XCTAssertFalse(denied.staticTexts["架空の自動読取の本"].exists)
        XCTAssertEqual(denied.state, .runningForeground)
    }

    func testDeniedUserCanRegisterAParcelByHand() {
        let app = launch("consent-denied")
        tap(app.tabBars.buttons["荷物"], in: app)
        assertAutoReadCount(0, in: app)
        tap(app.buttons["＋ 登録"], in: app)
        XCTAssertTrue(app.navigationBars["荷物を登録"].waitForExistence(timeout: 10))
        let title = app.textFields["品名"]
        tap(title, in: app)
        title.typeText("架空の本")
        XCTAssertEqual(title.value as? String, "架空の本")
        XCTAssertFalse(app.staticTexts["ai-reading-consent.title"].exists)
        XCTAssertEqual(app.state, .runningForeground)
    }

    func testDeniedUserCanLoadSamplesWithoutGrantingReadingPermission() {
        let app = launch("consent-denied")
        settingsPage("サンプルで試す", in: app)
        tap(app.buttons["demo-load"], in: app)
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["荷物"].isSelected)
        XCTAssertTrue(app.staticTexts["架空の本 上下巻セット"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["ai-reading-consent.title"].exists)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りを許可する"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["読み取りをやめる"].exists)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testUndecidedUserCanLoadSamplesWithoutSavingAConsentDecision() {
        let app = launch("consent-required")
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
        tap(app.buttons["ai-reading-consent.sample"], in: app)
        XCTAssertTrue(app.navigationBars["サンプルで試す"].waitForExistence(timeout: 10))
        tap(app.buttons["demo-load"], in: app)
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["荷物"].isSelected)
        XCTAssertTrue(app.staticTexts["架空の本 上下巻セット"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["ai-reading-consent.title"].exists)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りを許可する"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["読み取りをやめる"].exists)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testRevokingPermissionFromSettingsHidesForwardingDetails() {
        let app = launch("consent-allowed")
        settingsPage("あなたのメールの扱い", in: app)
        tap(app.buttons["読み取りをやめる"], in: app)
        XCTAssertTrue(app.buttons["読み取りを許可する"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["読み取りをやめる"].exists)
        tap(app.navigationBars.buttons.firstMatch, in: app)
        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 10))
        tap(app.buttons.containing(.staticText, identifier: "メールの転送").firstMatch, in: app)
        XCTAssertTrue(app.navigationBars["メールの転送"].waitForExistence(timeout: 10))
        assertForwardingHidden(in: app)
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testAnExistingGrantDoesNotStartReadingOnLoadOrRelaunch() {
        let app = launch("consent-allowed")
        settingsPage("メールの転送", in: app)
        XCTAssertTrue(forwardingControl("forwarding-address", in: app).waitForExistence(timeout: 10))
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
        app.terminate()
        app.launch()
        settingsPage("メールの転送", in: app)
        XCTAssertTrue(forwardingControl("forwarding-address", in: app).waitForExistence(timeout: 10))
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
        tap(app.tabBars.buttons["荷物"], in: app)
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["架空の自動読取の本"].exists)
    }

    func testGrantingFromSettingsReadsWaitingMailAndWithdrawalKeepsTheResult() {
        let app = launch("consent-denied")
        settingsPage("あなたのメールの扱い", in: app)
        assertAutoReadCount(0, in: app)
        tap(app.buttons["読み取りを許可する"], in: app)
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        XCTAssertTrue(app.staticTexts["ai-reading-consent.title"].waitForNonExistence(timeout: 10))
        assertAutomaticParcelIsVisible(in: app)
        settingsPage("あなたのメールの扱い", in: app)
        tap(app.buttons["読み取りをやめる"], in: app)
        XCTAssertTrue(app.buttons["読み取りを許可する"].waitForExistence(timeout: 10))
        assertConsentSaveCount(2, in: app)
        assertAutomaticParcelIsVisible(in: app)
        settingsPage("メールの転送", in: app)
        assertForwardingHidden(in: app)
        assertAutoReadCount(1, in: app)
    }

    func testAnAutomaticReadStaysInProgressAcrossForegroundWithoutStartingTwice() {
        let app = launch("consent-auto-hold")
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        let progress = app.descendants(matching: .any).matching(identifier: "consent-auto-read.progress").firstMatch
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(1, in: app)
        XCTAssertFalse(app.staticTexts["架空の自動読取の本"].exists)

        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        assertAutoReadCount(1, in: app)

        tap(app.buttons["consent-auto-read.complete"], in: app)
        XCTAssertTrue(progress.waitForNonExistence(timeout: 10))
        assertAutomaticParcelIsVisible(in: app)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りをやめる"].waitForExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(1, in: app)
    }

    func testAutomaticReadingAtTheDailyLimitKeepsRemainingMailAndPermission() {
        let app = launch("consent-auto-limit")
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        XCTAssertTrue(app.staticTexts["今日の読み取り上限に達しました。残りは明日の0時から読み取れます。"].waitForExistence(timeout: 10))
        assertAutomaticParcelIsVisible(in: app)
        settingsPage("うまく届かないとき", in: app)
        XCTAssertTrue(app.staticTexts["今日の読み取り上限に達しました。明日の0時から読み取れます。"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["読み取る"].exists)
        assertAutoReadCount(1, in: app)
        assertManualReadCount(0, in: app)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りをやめる"].waitForExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
    }

    func testStoppedAutomaticReadingKeepsPermissionAndDoesNotInventAResult() {
        let app = launch("consent-auto-stopped")
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        XCTAssertTrue(app.staticTexts["メールの読み取りは停止中です。"].waitForExistence(timeout: 10))
        tap(app.tabBars.buttons["荷物"], in: app)
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["架空の自動読取の本"].exists)
        settingsPage("うまく届かないとき", in: app)
        XCTAssertTrue(app.staticTexts["メールの読み取りは停止中です。荷物を手で登録しますか？"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["荷物を登録"].exists)
        assertAutoReadCount(1, in: app)
        assertManualReadCount(0, in: app)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りをやめる"].waitForExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
    }

    func testPartialAutomaticFailureKeepsItsParcelAndRetriesOnlyAfterAManualPress() {
        let app = launch("consent-auto-failed")
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        XCTAssertTrue(app.staticTexts["読み取れなかったメールがあります。時間をおいてお試しください。"].waitForExistence(timeout: 10))
        assertAutomaticParcelIsVisible(in: app)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りをやめる"].waitForExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        settingsPage("うまく届かないとき", in: app)
        XCTAssertTrue(app.staticTexts["読み取れなかったメールがあります。時間をおいて読み取りますか？"].waitForExistence(timeout: 10))
        assertAutoReadCount(1, in: app)
        assertManualReadCount(0, in: app)
        // The server's claimed automatic attempt is not replayed. This explicit press uses the {} overload.
        tap(app.buttons["読み取る"], in: app)
        XCTAssertTrue(app.staticTexts["未読のメールはありません。"].waitForExistence(timeout: 10))
        assertAutoReadCount(1, in: app)
        assertManualReadCount(1, in: app)
        assertConsentSaveCount(1, in: app)
        assertAutomaticParcelIsVisible(in: app)
    }

    func testPrivacyOpensInsideTheAppAndReturnsToTheConsentPrompt() {
        let app = launch("consent-required")
        tap(app.buttons["ai-reading-consent.privacy"], in: app)
        let policy = app.descendants(matching: .any).matching(identifier: "ai-reading-consent.privacy-sheet").firstMatch
        XCTAssertTrue(policy.waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
        tap(app.buttons["閉じる"], in: app)
        XCTAssertTrue(policy.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["ai-reading-consent.allow"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["ai-reading-consent.deny"].exists)
    }

    func testReadFailureDoesNotPretendToBeAnUndecidedConsent() {
        let app = launch("consent-error")
        let error = app.descendants(matching: .any).matching(identifier: "ai-reading-consent.error").firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["ai-reading-consent.allow"].exists)
        XCTAssertFalse(app.buttons["ai-reading-consent.deny"].exists)
        assertForwardingHidden(in: app)
        assertAutoReadCount(0, in: app)
    }

    func testFirstGuideStaysAliveDuringASlowConsentRecheck() {
        let app = launch("consent-onboarding")
        let guide = app.descendants(matching: .any).matching(identifier: "consent-onboarding.guide").firstMatch
        let heading = app.staticTexts["最後に、メールの自動転送を設定しますか？"]
        let address = forwardingControl("forwarding-address", in: app)
        XCTAssertTrue(guide.waitForExistence(timeout: 10))
        XCTAssertTrue(heading.exists)
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        let originalAddress = address.label
        XCTAssertTrue(originalAddress.contains("@"))

        tap(app.buttons["consent-onboarding.reload"], in: app)
        let loading = app.descendants(matching: .any).matching(identifier: "consent-onboarding.loading").firstMatch
        XCTAssertTrue(loading.waitForExistence(timeout: 10))
        // These belong to the real guide, not a fake's call counter or an outer navigation wrapper.
        XCTAssertTrue(guide.exists)
        XCTAssertTrue(heading.exists)
        XCTAssertTrue(app.buttons["設定しました"].exists)
        XCTAssertFalse(address.exists)
        XCTAssertFalse(app.staticTexts[originalAddress].exists)

        tap(app.buttons["consent-onboarding.complete"], in: app)
        XCTAssertTrue(loading.waitForNonExistence(timeout: 10))
        XCTAssertTrue(guide.exists)
        XCTAssertTrue(heading.exists)
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        XCTAssertEqual(address.label, originalAddress)
        // The next action still works after the held read returns.
        tap(app.buttons["あとで"], in: app)
        XCTAssertTrue(guide.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        assertAutoReadCount(0, in: app)
    }
}
