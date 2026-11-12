import XCTest

/// Exercises the real models, writer and category sheets over a local PostgREST transport.
@MainActor
final class CategorySavingUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private let hobby = "趣味・レジャー"

    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        // The existing empty preview bootstraps without live configuration; the second flag owns this fixture.
        app.launchArguments = ["-otodoke-ui-preview", "empty", "-otodoke-category-preview", scenario]
        app.launch()
        return app
    }

    private func check(_ condition: Bool, _ name: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if !condition { diagnose(name, in: app) }
        XCTAssertTrue(condition, name, file: file, line: line)
    }

    private func diagnose(_ name: String, in app: XCUIApplication) {
        let safeName = name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
        let stem = "b6-category-\(safeName)-\(UUID().uuidString)"
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
                let error = XCTAttachment(string: "Diagnostic export failed: \(error)")
                error.lifetime = .keepAlways
                activity.add(error)
            }
        }
    }

    private func enabled(_ element: XCUIElement) {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        wait(for: [ready], timeout: 10)
    }

    private func saveScreenshot(_ name: String, in app: XCUIApplication) throws {
        guard let path = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"] else { return }
        let directory = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try app.screenshot().pngRepresentation.write(to: directory.appendingPathComponent(name))
    }

    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        check(element.waitForExistence(timeout: 10), "missing-control", in: app)
        for _ in 0..<8 where !element.isHittable { app.swipeUp() }
        check(element.isHittable, "control-not-hittable", in: app)
        enabled(element)
        element.tap()
    }

    private func choice(_ label: String, in app: XCUIApplication) -> XCUIElement {
        // A selected row includes the checkmark in its combined label. The chip has a different prefix.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
    }

    private func openSheet(in app: XCUIApplication, category: String = "食費") {
        tap(app.buttons["分類を変える: \(category)"], in: app)
        check(app.buttons["閉じる"].waitForExistence(timeout: 10), "sheet-not-open", in: app)
        enabled(choice(hobby, in: app))
    }

    private func assertErrorAndNextChoice(in app: XCUIApplication) {
        let error = app.staticTexts.matching(NSPredicate(format: "label IN %@", [
            "保存できませんでした", "確かめられませんでした", "保存されていませんでした。もう一度選んでください。"
        ])).firstMatch
        check(error.waitForExistence(timeout: 10), "missing-save-error", in: app)
        for _ in 0..<3 where !error.isHittable { app.swipeUp() }
        check(error.isHittable, "save-error-not-visible", in: app)
        check(app.buttons["閉じる"].exists, "sheet-closed-on-failure", in: app)
        let next = choice(hobby, in: app)
        check(next.exists, "next-choice-missing", in: app)
        enabled(next)
        check(next.isHittable, "next-choice-not-hittable", in: app)
    }

    private func assertServer(patches: Int, stored: String, in app: XCUIApplication) {
        let writes = app.descendants(matching: .any).matching(identifier: "category-preview.patch-count").firstMatch
        let state = app.descendants(matching: .any).matching(identifier: "category-preview.stored").firstMatch
        check(writes.waitForExistence(timeout: 10), "patch-probe-missing", in: app)
        check(state.waitForExistence(timeout: 10), "stored-probe-missing", in: app)
        XCTAssertEqual(writes.value as? String, String(patches))
        XCTAssertEqual(state.value as? String, stored)
    }

    private func assertReadFailureRecoveryTrace(in app: XCUIApplication) {
        let trace = app.descendants(matching: .any).matching(identifier: "category-preview.request-trace").firstMatch
        check(trace.waitForExistence(timeout: 10), "request-trace-missing", in: app)
        let events = (trace.value as? String ?? "").split(separator: ",").map(String.init)
        XCTAssertEqual(events.filter { $0.hasPrefix("PATCH.") }, ["PATCH.1", "PATCH.2"])
        guard let firstWrite = events.firstIndex(of: "PATCH.1"), let failedRead = events.firstIndex(of: "GET.failed"),
              let secondWrite = events.firstIndex(of: "PATCH.2"),
              let confirmationRead = events.indices.first(where: { $0 > failedRead && events[$0] == "GET.ok" }) else {
            check(false, "recovery-request-sequence-missing", in: app)
            return
        }
        // Inspect the real transport after dismissal; modal accessibility need not expose the root probes.
        XCTAssertLessThan(firstWrite, failedRead)
        XCTAssertLessThan(failedRead, confirmationRead)
        XCTAssertLessThan(confirmationRead, secondWrite, "the uncertain write must be read back before another PATCH")
    }

    private func assertSaved(in app: XCUIApplication, category: String, stored: String, patches: Int, afterReadFailure: Bool = false) {
        check(app.buttons["閉じる"].waitForNonExistence(timeout: 10), "sheet-still-open-after-success", in: app)
        check(app.buttons["分類を変える: \(category)"].waitForExistence(timeout: 10), "saved-chip-missing", in: app)
        assertServer(patches: patches, stored: stored, in: app)
        if afterReadFailure { assertReadFailureRecoveryTrace(in: app) }
        openSheet(in: app, category: category)
        check(choice(category, in: app).isSelected, "saved-choice-not-selected", in: app)
    }

    func testSpendConflictKeepsTheSheetOpenAndRetriesAgainstTheLatestVersion() throws {
        let app = launch("spend-conflict")
        openSheet(in: app)
        tap(choice(hobby, in: app), in: app)
        assertErrorAndNextChoice(in: app)
        try saveScreenshot("b6-category-failure-retained.png", in: app)
        XCTAssertTrue(choice("食費", in: app).isSelected)
        XCTAssertFalse(choice(hobby, in: app).isSelected)
        tap(choice(hobby, in: app), in: app)
        assertSaved(in: app, category: hobby, stored: "hobby|user", patches: 2)
        try saveScreenshot("b6-category-confirmed-selection.png", in: app)
    }

    func testSpendUnknownKeepsTheSheetOpenUntilAConfirmedUserChoice() {
        let app = launch("spend-unknown")
        openSheet(in: app)
        tap(choice(hobby, in: app), in: app)
        assertErrorAndNextChoice(in: app)
        XCTAssertTrue(choice("食費", in: app).isSelected)
        tap(choice(hobby, in: app), in: app)
        assertSaved(in: app, category: hobby, stored: "hobby|user", patches: 2)
    }

    func testSpendReadFailureConfirmsFirstAndSavesOnlyOnTheNextExplicitChoice() {
        let app = launch("spend-read-failed")
        openSheet(in: app)
        tap(choice(hobby, in: app), in: app)
        assertErrorAndNextChoice(in: app)
        // The first explicit retry confirms the uncertain result and keeps this editor alive.
        tap(choice(hobby, in: app), in: app)
        let notSaved = app.staticTexts["保存されていませんでした。もう一度選んでください。"]
        check(notSaved.waitForExistence(timeout: 10), "confirmation-did-not-report-unsaved-choice", in: app)
        assertErrorAndNextChoice(in: app)
        XCTAssertTrue(choice("食費", in: app).isSelected)
        XCTAssertFalse(choice(hobby, in: app).isSelected)
        // A further explicit choice writes against the confirmed version and then dismisses.
        tap(choice(hobby, in: app), in: app)
        assertSaved(in: app, category: hobby, stored: "hobby|user", patches: 2, afterReadFailure: true)
    }

    func testSpendConfirmedSaveClosesTheSheetAndSelectsTheCategory() {
        let app = launch("spend-success")
        openSheet(in: app)
        tap(choice(hobby, in: app), in: app)
        assertSaved(in: app, category: hobby, stored: "hobby|user", patches: 1)
    }

    func testSpendAppliedUnknownClosesOnlyAfterReadBackConfirmsUserSource() {
        let app = launch("spend-applied-unknown")
        openSheet(in: app)
        tap(choice(hobby, in: app), in: app)
        assertSaved(in: app, category: hobby, stored: "hobby|user", patches: 1)
    }

    func testDetailMatchingAutomaticCategoryIsNotAConfirmedUserChoice() {
        let app = launch("detail-automatic-unknown")
        openSheet(in: app)
        tap(choice("食費", in: app), in: app)
        assertErrorAndNextChoice(in: app)
        // The value was already food, but its auto source still has to become the person's choice.
        tap(choice("食費", in: app), in: app)
        assertSaved(in: app, category: "食費", stored: "food|user", patches: 2)
    }

    func testSpendFilteredConflictKeepsTheEditorAfterTheOrderLeavesTheFilter() {
        let app = launch("spend-filtered-conflict")
        tap(choice("食費", in: app), in: app)
        openSheet(in: app)
        tap(choice(hobby, in: app), in: app)
        assertErrorAndNextChoice(in: app)
        XCTAssertTrue(choice("美容・健康", in: app).isSelected)
        tap(choice(hobby, in: app), in: app)
        check(app.buttons["閉じる"].waitForNonExistence(timeout: 10), "filtered-sheet-still-open-after-success", in: app)
        check(app.staticTexts["この条件の注文はありません"].waitForExistence(timeout: 10), "filter-did-not-remove-saved-order", in: app)
        assertServer(patches: 2, stored: "hobby|user", in: app)
        // Removing the filter reveals the confirmed choice, rather than an optimistic sheet value.
        tap(app.buttons["全期間"], in: app)
        check(app.buttons["分類を変える: \(hobby)"].waitForExistence(timeout: 10), "saved-order-not-restored-by-filter-change", in: app)
        openSheet(in: app, category: hobby)
        XCTAssertTrue(choice(hobby, in: app).isSelected)
    }
}
