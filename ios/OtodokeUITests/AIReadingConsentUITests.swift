import XCTest

/// The touch-target size comparison, kept outside the main-actor test classes so pure tests can call it.
enum TouchTarget {
    /// Smallest touch target side, in points.
    static let minimumTargetSide: CGFloat = 44
    /// Slack for a point value that is a difference of two pixel edges divided by the scale. At @3x the link spans
    /// 1516px to 1648px (132px = 44pt), but 1648/3 - 1516/3 evaluates to 43.99999999999994 in double precision.
    /// The slack is far below one pixel (1/3pt), so a target that is truly smaller still fails. Unit: points.
    static let targetRoundingSlack: CGFloat = 1e-6

    static func meetsMinimumTarget(_ side: CGFloat) -> Bool {
        side >= minimumTargetSide - targetRoundingSlack
    }
}

/// The real consent and settings screens, backed by the DEBUG consent server and made-up mail.
@MainActor
final class AIReadingConsentUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ scenario: String, flags: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-otodoke-ui-preview", scenario, "-ConsentFixtureID", UUID().uuidString] + flags
        app.launch()
        return app
    }

    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        let exists = element.waitForExistence(timeout: 10)
        if !exists { saveDiagnostics("tap-missing", in: app) }
        XCTAssertTrue(exists)
        reveal(element, in: app)
        let readyToTap = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: element)
        check(XCTWaiter.wait(for: [readyToTap], timeout: 10) == .completed, "tap-never-became-hittable", in: app)
        let hittable = element.isHittable
        if !hittable { saveDiagnostics("tap-not-hittable", in: app) }
        XCTAssertTrue(hittable)
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        wait(for: [enabled], timeout: 10)
        element.tap()
    }

    private func control(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func check(_ condition: Bool, _ name: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if !condition { saveDiagnostics(name, in: app) }
        XCTAssertTrue(condition, name, file: file, line: line)
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        // Safari is a separate presented child. Its close button is outside the consent card.
        // Never scroll or dismiss that child by sending gestures to the card behind it.
        if control("ai-reading-consent.privacy-sheet", in: app).exists { return }
        let modal = control("ai-reading-consent.modal", in: app)
        for _ in 0..<12 {
            if !modal.exists {
                if element.isHittable { return }
                app.swipeUp()
            } else {
                let visible = modal.frame.intersection(control("ai-reading-consent.viewport", in: app).frame)
                if element.isHittable, visible.insetBy(dx: -1, dy: -1).contains(element.frame) { return }
                let target = element.frame
                // A genuinely oversized paragraph must still fail the strict containment assertion.
                guard target.height <= visible.height, !visible.isEmpty else { return }
                let safe = visible.insetBy(dx: 8, dy: 8)
                let missing = target.minY < safe.minY ? target.minY - safe.minY : max(0, target.maxY - safe.maxY)
                guard abs(missing) > 1 else { return }
                // UIKit consumes the initial drag slop. A tiny correction must still begin a scroll.
                let distance = min(max(abs(missing), 32), safe.height * 0.45)
                let startY = missing > 0 ? safe.maxY - 12 : safe.minY + 12
                let endY = startY + (missing > 0 ? -distance : distance)
                let origin = modal.coordinate(withNormalizedOffset: .zero)
                let start = origin.withOffset(CGVector(dx: visible.midX - modal.frame.minX, dy: startY - modal.frame.minY))
                let end = origin.withOffset(CGVector(dx: visible.midX - modal.frame.minX, dy: endY - modal.frame.minY))
                // Move only the missing frame distance, then hold to avoid momentum overshooting it.
                start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
            }
        }
    }

    private func assertBackgroundUnavailable(in app: XCUIApplication) {
        for (index, title) in ["荷物", "カレンダー", "支出", "設定"].enumerated() {
            check(!app.tabBars.buttons[title].exists, "background-tab-visible-\(index)", in: app)
        }
        check(!app.buttons["＋ 登録"].exists, "background-registration-visible", in: app)
        check(!app.buttons["ai-reading-consent.manual"].exists, "manual-bypass-visible", in: app)
        check(!app.buttons["ai-reading-consent.sample"].exists, "sample-bypass-visible", in: app)
        check(!control("consent-auto-read.progress", in: app).exists, "background-auto-progress-visible", in: app)
        check(!control("consent-preview.save-count", in: app).exists, "background-save-probe-visible", in: app)
        check(!control("consent-preview.auto-read-count", in: app).exists, "background-auto-probe-visible", in: app)
        assertForwardingHidden(in: app)
    }

    private func assertPopup(in app: XCUIApplication) {
        let modal = control("ai-reading-consent.modal", in: app)
        check(modal.waitForExistence(timeout: 10), "popup-missing", in: app)
        check(app.staticTexts["ai-reading-consent.title"].waitForExistence(timeout: 10), "popup-title-missing", in: app)
        check(app.buttons["ai-reading-consent.allow"].waitForExistence(timeout: 10), "allow-missing", in: app)
        check(app.buttons["ai-reading-consent.deny"].waitForExistence(timeout: 10), "deny-missing", in: app)
        assertBackgroundUnavailable(in: app)
    }

    private func assertReachableLayout(in app: XCUIApplication) {
        assertPopup(in: app)
        let modal = control("ai-reading-consent.modal", in: app)
        let viewport = control("ai-reading-consent.viewport", in: app)
        check(viewport.waitForExistence(timeout: 10), "viewport-missing", in: app)
        check(!modal.frame.isEmpty, "popup-empty-frame", in: app)
        check(viewport.frame.insetBy(dx: -1, dy: -1).contains(modal.frame), "popup-outside-viewport", in: app)
        check(abs(modal.frame.midX - viewport.frame.midX) <= 2, "popup-center-x", in: app)
        check(abs(modal.frame.midY - viewport.frame.midY) <= 2, "popup-center-y", in: app)
        for identifier in ["ai-reading-consent.title", "ai-reading-consent.body", "ai-reading-consent.explanation", "ai-reading-consent.privacy", "ai-reading-consent.allow", "ai-reading-consent.deny"] {
            let element = control(identifier, in: app)
            check(element.exists, "missing-\(identifier)", in: app)
            reveal(element, in: app)
            check(element.isHittable, "unreachable-\(identifier)", in: app)
            check(modal.frame.intersection(viewport.frame).insetBy(dx: -1, dy: -1).contains(element.frame), "clipped-\(identifier)", in: app)
            if ["ai-reading-consent.privacy", "ai-reading-consent.allow", "ai-reading-consent.deny"].contains(identifier) {
                XCTAssertTrue(TouchTarget.meetsMinimumTarget(element.frame.height), "\(identifier) height \(element.frame.height)")
                XCTAssertTrue(TouchTarget.meetsMinimumTarget(element.frame.width), "\(identifier) width \(element.frame.width)")
            }
        }
    }

    private func savePopup(_ name: String, in app: XCUIApplication) throws {
        guard let path = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"] else { return }
        let directory = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let viewport = control("ai-reading-consent.viewport", in: app)
        XCTAssertTrue(viewport.exists)
        try viewport.screenshot().pngRepresentation.write(to: directory.appendingPathComponent(name))
    }

    private func showBothChoicesForScreenshot(in app: XCUIApplication) {
        reveal(app.buttons["ai-reading-consent.allow"], in: app)
        let visible = control("ai-reading-consent.modal", in: app).frame.intersection(control("ai-reading-consent.viewport", in: app).frame)
        for identifier in ["ai-reading-consent.deny", "ai-reading-consent.allow"] {
            let button = app.buttons[identifier]
            check(visible.insetBy(dx: -1, dy: -1).contains(button.frame), "choices-image-clipped-\(identifier)", in: app)
            check(button.isHittable, "choices-image-unreachable-\(identifier)", in: app)
        }
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
            check(!forwardingControl(identifier, in: app).exists, "exposed-\(identifier)", in: app)
        }
        XCTAssertFalse(app.buttons["承認ページを開く"].exists)
        if let address { XCTAssertFalse(app.staticTexts[address].exists) }
    }

    private func assertConsentSaveCount(_ count: Int, in app: XCUIApplication) {
        let identifier = control("ai-reading-consent.modal", in: app).exists ? "consent-preview.modal-save-count" : "consent-preview.save-count"
        let counter = control(identifier, in: app)
        check(counter.waitForExistence(timeout: 10), "save-count-probe-missing", in: app)
        if counter.value as? String != String(count) { saveDiagnostics("save-count-mismatch", in: app) }
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
        let target = control("ai-reading-consent.modal", in: app).exists ? identifier.replacingOccurrences(of: "consent-preview.", with: "consent-preview.modal-") : identifier
        let counter = control(target, in: app)
        check(counter.waitForExistence(timeout: 10), "api-count-probe-missing", in: app)
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
        XCTAssertEqual(app.staticTexts["ai-reading-consent.explanation"].label, "メールの件名・差出人・本文を送り、荷物の情報を取り出します。")
        XCTAssertTrue(app.buttons["ai-reading-consent.allow"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["ai-reading-consent.deny"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["ai-reading-consent.allow"].label, "許可する")
        XCTAssertEqual(app.buttons["ai-reading-consent.deny"].label, "許可しない")
        XCTAssertEqual(app.buttons["ai-reading-consent.privacy"].label, "プライバシーポリシー")
        assertReachableLayout(in: app)
        try savePopup("b14-ai-reading-consent.png", in: app)
        // This audits the modal-only accessibility tree, not VoiceOver's spoken output.
        if #available(iOS 17.0, *) { try app.performAccessibilityAudit(for: [.hitRegion, .textClipped, .contrast]) }
    }

    func testDarkAppearancePopupPassesTheSameUnfilteredAccessibilityAudit() throws {
        let app = launch("consent-required", flags: ["-ConsentDarkAppearance"])
        assertReachableLayout(in: app)
        let appearance = control("consent-preview.modal-color-scheme", in: app)
        check(appearance.waitForExistence(timeout: 10), "appearance-probe-missing", in: app)
        check(appearance.value as? String == "dark", "dark-appearance-was-not-applied", in: app)
        try savePopup("b14-ai-reading-consent-dark.png", in: app)
        if #available(iOS 17.0, *) { try app.performAccessibilityAudit(for: [.hitRegion, .textClipped, .contrast]) }
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
        let app = launch("consent-required")
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
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

    func testDecliningThePromptStillLetsTheUserLoadSamplesWithoutGrantingReading() {
        let app = launch("consent-required")
        assertPopup(in: app)
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        settingsPage("サンプルで試す", in: app)
        tap(app.buttons["demo-load"], in: app)
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["荷物"].isSelected)
        XCTAssertTrue(app.staticTexts["架空の本 上下巻セット"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["ai-reading-consent.title"].exists)
        settingsPage("あなたのメールの扱い", in: app)
        XCTAssertTrue(app.buttons["読み取りを許可する"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["読み取りをやめる"].exists)
        assertConsentSaveCount(1, in: app)
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

    func testMailHandlingShowsRetainedResultsThenTheWaitingDeadlineOnceEach() {
        let app = launch("consent-denied")
        settingsPage("あなたのメールの扱い", in: app)
        let retainedCopy = "読み取りを許可しているときだけ、Anthropic の Claude に送ります。すでに読み取った荷物と結果は残ります。設定の「サンプルで試す」にある「すべての荷物を消す」で消せます。"
        let deadlineCopy = "許可を待つメールは、届いてから 14 日で消えます。"
        let retained = app.staticTexts[retainedCopy]
        let deadline = app.staticTexts[deadlineCopy]
        check(retained.waitForExistence(timeout: 10), "retained-results-paragraph-missing", in: app)
        reveal(retained, in: app)
        check(retained.isHittable, "retained-results-paragraph-not-visible", in: app)
        check(deadline.waitForExistence(timeout: 10), "waiting-deadline-paragraph-missing", in: app)
        reveal(deadline, in: app)
        check(deadline.isHittable, "waiting-deadline-paragraph-not-visible", in: app)
        check(retained.frame.maxY <= deadline.frame.minY + 1, "consent-settings-paragraphs-reordered", in: app)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", retainedCopy)).count, 1)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", deadlineCopy)).count, 1)
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
        let app = launch("consent-required")
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        settingsPage("あなたのメールの扱い", in: app)
        assertAutoReadCount(0, in: app)
        tap(app.buttons["読み取りを許可する"], in: app)
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        XCTAssertTrue(app.staticTexts["ai-reading-consent.title"].waitForNonExistence(timeout: 10))
        assertAutomaticParcelIsVisible(in: app)
        settingsPage("あなたのメールの扱い", in: app)
        tap(app.buttons["読み取りをやめる"], in: app)
        XCTAssertTrue(app.buttons["読み取りを許可する"].waitForExistence(timeout: 10))
        assertConsentSaveCount(3, in: app)
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
        assertBackgroundUnavailable(in: app)
    }

    func testReadFailureDoesNotPretendToBeAnUndecidedConsent() {
        let app = launch("consent-error")
        let error = app.descendants(matching: .any).matching(identifier: "ai-reading-consent.error").firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["ai-reading-consent.allow"].exists)
        XCTAssertFalse(app.buttons["ai-reading-consent.deny"].exists)
        assertBackgroundUnavailable(in: app)
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

    func testBackgroundTapAndSwipeNeverDecideOrDismissThePopup() {
        let app = launch("consent-required")
        assertPopup(in: app)
        let viewport = control("ai-reading-consent.viewport", in: app).frame
        let modal = control("ai-reading-consent.modal", in: app)
        let point = CGPoint(x: viewport.minX + 3, y: viewport.midY)
        XCTAssertFalse(modal.frame.contains(point), "the test must tap outside the card")
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y)).tap()
        assertPopup(in: app)
        modal.swipeDown()
        assertPopup(in: app)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
        XCUIDevice.shared.press(.home)
        app.activate()
        assertPopup(in: app)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testAnUnansweredPopupReturnsAfterRelaunch() {
        let app = launch("consent-required")
        assertPopup(in: app)
        app.terminate()
        app.launch()
        assertPopup(in: app)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testADeclinedChoiceDoesNotReturnAfterRelaunch() {
        let app = launch("consent-required")
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["荷物"].waitForExistence(timeout: 10))
        XCTAssertFalse(control("ai-reading-consent.modal", in: app).exists)
        settingsPage("メールの転送", in: app)
        assertForwardingHidden(in: app)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testAGrantedChoiceDoesNotReturnOrReadTheBacklogAgainAfterRelaunch() {
        let app = launch("consent-required")
        tap(app.buttons["ai-reading-consent.allow"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        assertAutomaticParcelIsVisible(in: app)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["荷物"].waitForExistence(timeout: 10))
        XCTAssertFalse(control("ai-reading-consent.modal", in: app).exists)
        settingsPage("メールの転送", in: app)
        XCTAssertTrue(forwardingControl("forwarding-address", in: app).waitForExistence(timeout: 10))
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    private func assertFailedSaveKeepsTheChoice(_ scenario: String) {
        let app = launch(scenario)
        assertPopup(in: app)
        for (attempt, identifier) in ["ai-reading-consent.allow", "ai-reading-consent.deny"].enumerated() {
            tap(app.buttons[identifier], in: app)
            let error = control("ai-reading-consent.error", in: app)
            XCTAssertTrue(error.waitForExistence(timeout: 10))
            XCTAssertTrue(error.label.contains("読み取りの許可を保存できませんでした。もう一度お試しください。"))
            assertPopup(in: app)
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons[identifier])
            wait(for: [ready], timeout: 10)
            assertConsentSaveCount(attempt + 1, in: app)
            assertAutoReadCount(0, in: app)
        }
        app.terminate()
        app.launch()
        assertPopup(in: app)
        assertConsentSaveCount(0, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testAServerRefusalCannotDismissOrPersistAnUnconfirmedChoice() {
        assertFailedSaveKeepsTheChoice("consent-save-error")
    }

    func testAnOfflineSaveCannotDismissOrPersistAnUnconfirmedChoice() {
        assertFailedSaveKeepsTheChoice("consent-save-offline")
    }

    func testTheInitialUnreadDecisionShowsNoChoicesUntilTheHeldReadCompletes() {
        let app = launch("consent-loading")
        let release = app.buttons["consent-preview.finish-initial-load"]
        XCTAssertTrue(release.waitForExistence(timeout: 10))
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).exists)
        XCTAssertFalse(app.buttons["ai-reading-consent.allow"].exists)
        XCTAssertFalse(app.buttons["ai-reading-consent.deny"].exists)
        assertBackgroundUnavailable(in: app)
        assertConsentSaveCount(0, in: app)
        tap(release, in: app)
        check(release.waitForNonExistence(timeout: 10), "initial-load-release-still-visible", in: app)
        assertPopup(in: app)
        assertConsentSaveCount(0, in: app)
    }

    func testAConsentRequestAppearsAboveAnOpenManualSheetAndKeepsItsInput() {
        let app = launch("consent-sheet-request")
        check(app.tabBars.buttons["荷物"].waitForExistence(timeout: 10), "manual-background-tab-missing", in: app)
        tap(app.buttons["＋ 登録"], in: app)
        check(app.navigationBars["荷物を登録"].waitForExistence(timeout: 10), "manual-sheet-missing", in: app)
        let title = app.textFields["品名"]
        tap(title, in: app)
        let input = "架空の入力を保持する本"
        title.typeText(input)
        XCTAssertEqual(title.value as? String, input)
        check(app.keyboards.firstMatch.waitForExistence(timeout: 10), "manual-keyboard-was-not-shown", in: app)

        // This fixture calls the real requestReadingConsent method after an actual background/return.
        // The existing manual sheet and its model must survive the new native presentation above it.
        XCUIDevice.shared.press(.home)
        app.activate()
        assertPopup(in: app)
        check(app.keyboards.firstMatch.waitForNonExistence(timeout: 10), "manual-keyboard-visible-over-popup", in: app)
        check(!app.navigationBars["荷物を登録"].exists, "manual-sheet-accessible-behind-popup", in: app)
        check(!title.exists, "manual-input-accessible-behind-popup", in: app)
        assertConsentSaveCount(0, in: app)
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        check(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10), "manual-popup-did-not-close-after-denial", in: app)
        check(app.navigationBars["荷物を登録"].waitForExistence(timeout: 10), "manual-sheet-was-discarded", in: app)
        check(title.waitForExistence(timeout: 10), "manual-input-was-discarded", in: app)
        if title.value as? String != input { saveDiagnostics("manual-input-not-retained", in: app) }
        XCTAssertEqual(title.value as? String, input)
        tap(app.buttons["閉じる"], in: app)
        check(app.navigationBars["荷物を登録"].waitForNonExistence(timeout: 10), "manual-sheet-did-not-close", in: app)
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(0, in: app)
    }

    private func privacyRoundTrip(in app: XCUIApplication) {
        tap(app.buttons["ai-reading-consent.privacy"], in: app)
        let policy = control("ai-reading-consent.privacy-sheet", in: app)
        XCTAssertTrue(policy.waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
        tap(app.buttons["閉じる"], in: app)
        XCTAssertTrue(policy.waitForNonExistence(timeout: 10))
        assertPopup(in: app)
        // A long scrollable card need not expose its tiny instrumentation at every scroll offset.
        // These layout tests inspect the counters on the real tabs after the explicit denial below.
    }

    func testSmallViewportContainsTheRealPopupAndKeepsAllControlsReachable() throws {
        let app = launch("consent-required", flags: ["-ConsentSmallViewport"])
        assertReachableLayout(in: app)
        let viewport = control("ai-reading-consent.viewport", in: app)
        XCTAssertEqual(viewport.frame.width, 375, accuracy: 1)
        XCTAssertEqual(viewport.frame.height, 667, accuracy: 1)
        try savePopup("b14-ai-reading-consent-small.png", in: app)
        privacyRoundTrip(in: app)
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testMaximumAccessibilityTextKeepsTheRealPopupReadableAndOperable() throws {
        let app = launch("consent-required", flags: ["-ConsentAccessibilitySize"])
        assertReachableLayout(in: app)
        reveal(app.staticTexts["ai-reading-consent.title"], in: app)
        try savePopup("b14-ai-reading-consent-large-text.png", in: app)
        showBothChoicesForScreenshot(in: app)
        try savePopup("b14-ai-reading-consent-large-text-choices.png", in: app)
        privacyRoundTrip(in: app)
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testSmallViewportAndMaximumAccessibilityTextKeepTheChoicesReachable() throws {
        let app = launch("consent-required", flags: ["-ConsentSmallViewport", "-ConsentAccessibilitySize"])
        assertReachableLayout(in: app)
        showBothChoicesForScreenshot(in: app)
        try savePopup("b14-ai-reading-consent-small-large-text-choices.png", in: app)
        privacyRoundTrip(in: app)
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testShortViewportScrollsToPrivacyAndBothChoicesWithoutClippingTheCard() throws {
        let app = launch("consent-required", flags: ["-ConsentShortViewport"])
        assertReachableLayout(in: app)
        XCTAssertLessThanOrEqual(control("ai-reading-consent.viewport", in: app).frame.height, 375)
        try savePopup("b14-ai-reading-consent-short-viewport-choices.png", in: app)
        privacyRoundTrip(in: app)
        tap(app.buttons["ai-reading-consent.deny"], in: app)
        XCTAssertTrue(control("ai-reading-consent.modal", in: app).waitForNonExistence(timeout: 10))
        assertConsentSaveCount(1, in: app)
        assertAutoReadCount(0, in: app)
    }

    func testDeviceRotationKeepsThePopupAndRestoresPortrait() throws {
        let app = launch("consent-required")
        assertPopup(in: app)
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        assertReachableLayout(in: app)
        let landscape = app.frame.width > app.frame.height
        try savePopup(landscape ? "b14-ai-reading-consent-landscape.png" : "b14-ai-reading-consent-landscape-request-portrait-locked.png", in: app)
        let evidence = XCTAttachment(string: "B14 device requested landscapeLeft; app viewport=\(app.frame). The app declares portrait-only supported orientations.")
        evidence.lifetime = .keepAlways
        add(evidence)
        assertBackgroundUnavailable(in: app)
        assertConsentSaveCount(0, in: app)
    }
}

/// Pure checks of the touch-target comparison; the app is not launched.
final class MinimumTargetComparisonTests: XCTestCase {
    func testExactAndRoundedValuesPass() {
        XCTAssertTrue(TouchTarget.meetsMinimumTarget(44))
        XCTAssertTrue(TouchTarget.meetsMinimumTarget(43.99999999999994))
        XCTAssertTrue(TouchTarget.meetsMinimumTarget(1648.0 / 3 - 1516.0 / 3))
    }

    func testRealShortfallsFail() {
        XCTAssertFalse(TouchTarget.meetsMinimumTarget(43.999))
        XCTAssertFalse(TouchTarget.meetsMinimumTarget(43.5))
    }
}
