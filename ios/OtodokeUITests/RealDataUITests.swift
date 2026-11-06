import XCTest

/// The app against the real Supabase project, on the QA account only. Runs only when
/// TEST_RUNNER_OTODOKE_REAL_IPC, TEST_RUNNER_OTODOKE_REAL_PASSWORD_FILE and TEST_RUNNER_OTODOKE_REAL_EMAIL
/// are set in xcodebuild's environment (the TEST_RUNNER_ prefix is dropped in the test). The tests run
/// in name order: test01 signs in, the others use that session.
/// - OTODOKE_REAL_EMAIL: the QA account's address.
/// - OTODOKE_REAL_PASSWORD_FILE: a file holding the QA account's password (password-v1; the code login is
///   gone). The test types it into the password field (a SecureField) and never takes a screenshot while it
///   is typed; the file is left as it is (the helper owns it).
/// - OTODOKE_REAL_IPC: a folder a helper on the Mac watches. The test writes req-*.json (read the
///   test rows, the Web's sections, or change a test row as another writer would) and waits for
///   res-*.json. The helper only touches the QA account's rows titled 【試験】.
/// - OTODOKE_REAL_SHOTS (optional): where the screenshots go, named qa-real-*.png.
/// Nothing secret is written into this file.
@MainActor
final class RealDataUITests: XCTestCase {
    private var ipc: URL!
    private var passwordFile: URL!
    private var shots: URL?
    private var seq = 0
    /// Names this test's requests; set when the test starts (every test case object is made before
    /// the first test runs, so a value taken at init would be the same for all of them).
    private var run = ""
    /// The QA account's address (OTODOKE_REAL_EMAIL; not kept in this public repository).
    private var email = ""

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    /// The paths from the environment; skips the test when they are not given.
    private func configure() throws {
        let env = ProcessInfo.processInfo.environment
        guard let ipcPath = env["OTODOKE_REAL_IPC"], let passwordPath = env["OTODOKE_REAL_PASSWORD_FILE"],
              let address = env["OTODOKE_REAL_EMAIL"], !address.isEmpty
        else {
            throw XCTSkip("the real-data check runs only on request")
        }
        email = address
        run = "\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 1000...9999))"
        ipc = URL(fileURLWithPath: ipcPath)
        passwordFile = URL(fileURLWithPath: passwordPath)
        shots = env["OTODOKE_REAL_SHOTS"].map { URL(fileURLWithPath: $0) }
    }

    // MARK: the check

    /// The app, signed in from an earlier test (test01 signs in); nil (and a failure) when it is not.
    private func launchSignedIn() throws -> XCUIApplication? {
        try configure()
        let app = XCUIApplication()
        app.launch()
        guard app.navigationBars["荷物"].waitForExistence(timeout: 30) else {
            XCTFail("not signed in")
            return nil
        }
        XCTAssertTrue(app.buttons["＋ 登録"].waitForExistence(timeout: 30), "the list loaded")
        return app
    }

    // Each step is its own test (run in name order), so each stays under the time allowance.

    /// 2. The sections, their counts and order, and the two page links, against the Web's logic.
    func test02List() throws {
        guard let app = try launchSignedIn() else { return }
        try checkList(app, label: "initial")
    }

    /// 3. Swipe 「届いた」 → one row delivered → 「元に戻す」 within 6 seconds → back.
    func test03SwipeAndUndo() throws {
        guard let app = try launchSignedIn() else { return }
        try swipeAndUndo(app)
    }

    /// 4. The toast goes by itself after 6 seconds (the row stays delivered).
    func test04ToastGoesAway() throws {
        guard let app = try launchSignedIn() else { return }
        try toastGoesAway(app)
    }

    /// 5. Another writer changed the row after it was shown: not saved, read again, then saved.
    func test05ConflictOnSwipe() throws {
        guard let app = try launchSignedIn() else { return }
        try conflictOnSwipe(app)
    }

    /// 6. The row was cancelled after it was shown: never written, gone from the list.
    func test06CancelledOnTheWay() throws {
        guard let app = try launchSignedIn() else { return }
        try cancelledOnTheWay(app)
    }

    /// 7. 「すべて受取済にする」 on 要確認, then 「元に戻す」.
    func test07DeliverAllAndUndo() throws {
        guard let app = try launchSignedIn() else { return }
        try deliverAllAndUndo(app)
    }

    /// 8. The detail: 「届いていない」, the category, and a category over a changed row.
    func test08DetailWrites() throws {
        guard let app = try launchSignedIn() else { return }
        try detailWrites(app)
    }

    /// 9. Over 1,000 rows: every row is read. The rows are added before the app starts, so the
    /// first read of the list is the one checked.
    func test09OverAThousand() throws {
        try configure()
        let expect = try helper(["op": "expect"])
        if (expect["total"] as? Int ?? 0) <= 1000 {
            let added = try helper(["op": "bulk", "n": 1050], timeout: 120)
            XCTAssertEqual(added["added"] as? Int, 1050)
        }
        guard let app = try launchSignedIn() else { return }
        try overAThousand(app)
    }

    /// 10. Pull to refresh reads the list again: a row another writer moved back shows up.
    func test10PullToRefresh() throws {
        guard let app = try launchSignedIn() else { return }
        let name = "【試験】トーストが消える荷物"
        let before = headerCounts(app, ["もうすぐ届く"])["もうすぐ届く"]
        XCTAssertFalse(app.staticTexts[name].exists)
        _ = try helper(["op": "set", "title": name, "status": "shipped"])
        let expect = try helper(["op": "expect"])
        let soon = try XCTUnwrap((expect["counts"] as? [String: Int])?["soon"])
        scrollToTop(app)
        pullToRefresh(app)
        let after = headerCounts(app, ["もうすぐ届く"])["もうすぐ届く"]
        record("pull-to-refresh-soon", "before=\(before.map(String.init) ?? "nil") after=\(after.map(String.init) ?? "nil") db=\(soon)")
        XCTAssertEqual(after, soon, "the list after pulling")
        XCTAssertTrue(scrollTo(app, app.staticTexts[name]), "the row is back on the list")
        shoot("pull-to-refresh")
    }

    /// 1. Login with the password, then the session survives a relaunch.
    func test01Login() throws {
        try configure()
        var app = XCUIApplication()
        app.launch()
        let emailField = app.textFields["you@example.com"]
        let list = app.navigationBars["荷物"]
        let start = Date()
        while !emailField.exists && !list.exists && Date().timeIntervalSince(start) < 30 {
            Thread.sleep(forTimeInterval: 0.3)
        }
        if list.exists {
            record("login", "already signed in (an earlier run's session); the login skipped")
        } else {
            XCTAssertTrue(emailField.exists, "the login screen")
            shoot("login")
            let password = try String(contentsOf: passwordFile, encoding: .utf8).trimmingCharacters(in: .newlines)
            XCTAssertFalse(password.isEmpty, "a password")
            emailField.tap()
            emailField.typeText(email)
            let field = app.secureTextFields["パスワード"]
            field.tap()
            field.typeText(password)
            app.buttons["ログイン"].firstMatch.tap()
            record("login", "password entered")
        }
        let title = app.navigationBars["荷物"]
        XCTAssertTrue(title.waitForExistence(timeout: 30), "signed in")
        guard title.exists else {
            // No screenshot here (the password was just typed).
            for m in ["メールアドレスかパスワードが違います。", "メールアドレスの確認がまだです。届いたメールのリンクを開いてください。", "回数が多いため、しばらく時間をおいてから、もう一度お試しください。", "つながりませんでした。少し時間をおいて、もう一度お試しください。", "うまくいきませんでした。もう一度お試しください。"] where app.staticTexts[m].exists {
                record("login-error", m)
            }
            XCTFail("not signed in; nothing more to check")
            return
        }
        XCTAssertTrue(app.buttons["＋ 登録"].waitForExistence(timeout: 30), "the list loaded")
        shoot("list-top")

        app.terminate()
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 30), "still signed in after a relaunch")
        XCTAssertFalse(app.staticTexts["ログイン"].exists)
        XCTAssertTrue(app.buttons["＋ 登録"].waitForExistence(timeout: 30))
        record("relaunch", "signed in: \(app.navigationBars["荷物"].exists)")
        shoot("relaunched")
    }

    // MARK: steps

    private func checkList(_ app: XCUIApplication, label: String) throws {
        let expect = try helper(["op": "expect"])
        let counts = try XCTUnwrap(expect["counts"] as? [String: Int])
        record("expect-\(label)", counts.description)
        scrollToTop(app)
        // 要確認 shows five, 「ほか N 件を見る」 the rest.
        let toCheck = try XCTUnwrap(expect["toCheck"] as? [String])
        if toCheck.count > 5 {
            let more = app.buttons["ほか \(toCheck.count - 5) 件を見る"]
            XCTAssertTrue(scrollTo(app, more), "ほか N 件を見る")
            shoot("\(label)-check-box")
            more.tap()
            Thread.sleep(forTimeInterval: 0.5)
            shoot("\(label)-check-box-open")
        }
        scrollToTop(app)
        if counts["unread"] == 0 {
            XCTAssertFalse(app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "まだ読んでいないメールが")).firstMatch.exists, "no unread notice")
        }
        for (header, key) in [("要確認", "toCheck"), ("配達中", "delivering"), ("もうすぐ届く", "soon"), ("注文中", "ordered")] {
            let n = counts[key] ?? -1
            if n == 0 && key != "ordered" {
                XCTAssertNil(headerCount(app, header, scroll: false), "\(header) not shown when empty")
                continue
            }
            let shown = headerCount(app, header, scroll: true)
            XCTAssertEqual(shown, n, "\(header) count")
            record("count-\(label)-\(key)", "ui=\(shown.map(String.init) ?? "nil") db=\(n)")
        }
        // The order of the cards, top to bottom, against toCheck + delivering + soon + ordered.
        let order = ["toCheck", "delivering", "soon", "ordered"].flatMap { (expect[$0] as? [String]) ?? [] }
        try checkOrder(app, expected: order, label: label)
        // The page links at the end.
        for (link, key) in [("届いた荷物", "delivered"), ("キャンセルした荷物", "cancelled")] {
            let n = counts[key] ?? -1
            let shown = pageLinkCount(app, link)
            XCTAssertEqual(shown, n, "\(link) count")
            record("count-\(label)-\(key)", "ui=\(shown.map(String.init) ?? "nil") db=\(n)")
        }
        shoot("\(label)-list-end")
        scrollToTop(app)
    }

    private func swipeAndUndo(_ app: XCUIApplication) throws {
        let name = "【試験】スワイプする荷物"
        let before = try rows(label: "swipe-before")
        try swipeDelivered(app, name)
        let toast = element(app, containing: "届いたにしました")
        XCTAssertTrue(toast.waitForExistence(timeout: 15), "toast")
        let shownAt = Date()
        shoot("swipe-toast")
        let after = try rows(label: "swipe-after")
        XCTAssertEqual(after[name]?["status"], "delivered")
        XCTAssertNotEqual(after[name]?["updated_at"], before[name]?["updated_at"])
        assertUnchanged(before, after, except: [name], "swipe")
        let elapsed = Date().timeIntervalSince(shownAt)
        record("swipe-undo-pressed-after", String(format: "%.1fs", elapsed))
        tapUndo(app, toast)
        XCTAssertTrue(waitGone(toast, 15), "toast gone after undo")
        let back = try waitRows(label: "swipe-undone") { $0[name]?["status"] == "shipped" }
        XCTAssertEqual(back[name]?["status"], "shipped")
        XCTAssertNotEqual(back[name]?["updated_at"], after[name]?["updated_at"])
        assertUnchanged(before, back, except: [name], "undo")
        XCTAssertTrue(scrollTo(app, app.staticTexts[name]), "the card is back on the list")
    }

    private func toastGoesAway(_ app: XCUIApplication) throws {
        let name = "【試験】トーストが消える荷物"
        let before = try rows(label: "toast-before")
        try swipeDelivered(app, name)
        let toast = element(app, containing: "届いたにしました")
        XCTAssertTrue(toast.waitForExistence(timeout: 15), "toast")
        let shownAt = Date()
        XCTAssertTrue(waitGone(toast, 12), "toast goes by itself")
        let lasted = Date().timeIntervalSince(shownAt)
        record("toast-lasted", String(format: "%.1fs", lasted))
        XCTAssertGreaterThan(lasted, 4.5)
        XCTAssertLessThan(lasted, 9)
        let after = try rows(label: "toast-after")
        XCTAssertEqual(after[name]?["status"], "delivered")
        assertUnchanged(before, after, except: [name], "toast")
        XCTAssertFalse(app.staticTexts[name].exists, "a delivered row leaves the list")
    }

    private func conflictOnSwipe(_ app: XCUIApplication) throws {
        let name = "【試験】競合する荷物"
        XCTAssertTrue(scrollTo(app, app.staticTexts[name]))
        let before = try rows(label: "conflict-before")
        let bumped = try helper(["op": "bump", "title": name])
        let stamp = try XCTUnwrap((bumped["row"] as? [String: Any])?["updated_at"] as? String)
        try swipeDelivered(app, name)
        let message = app.staticTexts["保存できませんでした。もう一度スワイプしてください。"]
        XCTAssertTrue(message.waitForExistence(timeout: 15), "not saved")
        shoot("conflict-message")
        let after = try rows(label: "conflict-after")
        XCTAssertEqual(after[name]?["status"], "shipped", "the app's write did not go through")
        XCTAssertEqual(after[name]?["updated_at"], stamp, "updated_at is the other writer's")
        assertUnchanged(before, after, except: [name], "conflict")
        XCTAssertFalse(element(app, containing: "届いたにしました").exists, "no toast")
        // Read again: the next swipe is on the new version and goes through; then put back.
        try swipeDelivered(app, name)
        let toast = element(app, containing: "届いたにしました")
        XCTAssertTrue(toast.waitForExistence(timeout: 15), "saved on the second swipe")
        tapUndo(app, toast)
        XCTAssertTrue(waitGone(toast, 15))
        let back = try waitRows(label: "conflict-retried-undone") { $0[name]?["status"] == "shipped" }
        XCTAssertEqual(back[name]?["status"], "shipped")
        assertUnchanged(before, back, except: [name], "conflict retry")
    }

    private func cancelledOnTheWay(_ app: XCUIApplication) throws {
        let name = "【試験】途中でキャンセルされる荷物"
        XCTAssertTrue(scrollTo(app, app.staticTexts[name]))
        let before = try rows(label: "cancel-before")
        let set = try helper(["op": "set", "title": name, "status": "cancelled"])
        let stamp = try XCTUnwrap((set["row"] as? [String: Any])?["updated_at"] as? String)
        try swipeDelivered(app, name)
        XCTAssertTrue(waitGone(app.staticTexts[name], 15), "the cancelled row leaves the list")
        XCTAssertFalse(element(app, containing: "届いたにしました").exists, "no toast")
        let after = try rows(label: "cancel-after")
        XCTAssertEqual(after[name]?["status"], "cancelled")
        XCTAssertEqual(after[name]?["updated_at"], stamp, "never written by the app")
        assertUnchanged(before, after, except: [name], "cancelled")
        shoot("cancelled-gone")
    }

    private func deliverAllAndUndo(_ app: XCUIApplication) throws {
        let before = try rows(label: "all-before")
        let names = before.keys.filter { $0.hasPrefix("【試験】要確認") }.sorted()
        XCTAssertEqual(names.count, 7)
        scrollToTop(app)
        let all = app.buttons["すべて受取済にする"]
        XCTAssertTrue(scrollTo(app, all))
        all.tap()
        let confirm = app.buttons["\(names.count) 件を受取済にする"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "second press")
        shoot("deliver-all-confirm")
        confirm.tap()
        let toast = element(app, containing: "\(names.count) 件を受取済にしました")
        XCTAssertTrue(toast.waitForExistence(timeout: 30), "bulk toast")
        shoot("deliver-all-toast")
        let after = try rows(label: "all-after")
        for n in names { XCTAssertEqual(after[n]?["status"], "delivered", n) }
        assertUnchanged(before, after, except: Set(names), "deliver all")
        tapUndo(app, toast)
        XCTAssertTrue(waitGone(toast, 30), "toast gone after undo")
        let back = try waitRows(label: "all-undone") { r in names.allSatisfy { r[$0]?["status"] != "delivered" } }
        for n in names { XCTAssertEqual(back[n]?["status"], before[n]?["status"], n) }
        assertUnchanged(before, back, except: Set(names), "deliver all undo")
        scrollToTop(app)
        XCTAssertTrue(scrollTo(app, app.buttons["すべて受取済にする"]), "要確認 is back")
        shoot("deliver-all-undone")
    }

    private func detailWrites(_ app: XCUIApplication) throws {
        // 「届いていない」: the row becomes delivered by another writer while the page is open.
        let back = "【試験】詳細で戻す荷物"
        XCTAssertTrue(scrollTo(app, app.staticTexts[back]))
        app.staticTexts[back].tap()
        XCTAssertTrue(app.staticTexts["お届け予定"].waitForExistence(timeout: 15), "detail")
        shoot("detail-open")
        let before = try rows(label: "notdelivered-before")
        _ = try helper(["op": "set", "title": back, "status": "delivered"])
        let notDelivered = app.buttons["届いていない"]
        for _ in 0..<3 where !notDelivered.exists {
            pullToRefresh(app)
            _ = notDelivered.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(notDelivered.exists, "届いていない after reading again")
        shoot("detail-delivered")
        let mid = try rows(label: "notdelivered-mid")
        notDelivered.tap()
        XCTAssertTrue(waitGone(notDelivered, 15), "back from delivered")
        let after = try waitRows(label: "notdelivered-after") { $0[back]?["status"] != "delivered" }
        XCTAssertEqual(after[back]?["status"], "shipped", "a carrier is known: shipped")
        XCTAssertNotEqual(after[back]?["updated_at"], mid[back]?["updated_at"])
        assertUnchanged(before, after, except: [back], "not delivered")
        shoot("detail-not-delivered")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))

        // The category: 食費 → 趣味・レジャー, recorded as the user's.
        let cat = "【試験】分類を変える荷物"
        XCTAssertTrue(scrollTo(app, app.staticTexts[cat]))
        app.staticTexts[cat].tap()
        let chip = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "分類:")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 15))
        XCTAssertTrue(chip.label.contains("食費"), chip.label)
        let catBefore = try rows(label: "category-before")
        chip.tap()
        let hobby = app.buttons["趣味・レジャー"]
        XCTAssertTrue(hobby.waitForExistence(timeout: 5))
        shoot("category-sheet")
        hobby.tap()
        XCTAssertTrue(waitGone(app.buttons["閉じる"], 15), "the sheet closes when saved")
        XCTAssertTrue(chip.label.contains("趣味・レジャー"), chip.label)
        let catAfter = try rows(label: "category-after")
        XCTAssertEqual(catAfter[cat]?["category"], "hobby")
        XCTAssertEqual(catAfter[cat]?["category_source"], "user")
        XCTAssertNotEqual(catAfter[cat]?["updated_at"], catBefore[cat]?["updated_at"])
        assertUnchanged(catBefore, catAfter, except: [cat], "category")
        shoot("category-saved")

        // Another writer touches the row; a choice on the version shown is not written.
        let bumped = try helper(["op": "bump", "title": cat])
        let stamp = try XCTUnwrap((bumped["row"] as? [String: Any])?["updated_at"] as? String)
        chip.tap()
        let other = app.buttons["その他"]
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.tap()
        let notSaved = app.staticTexts["保存されていませんでした。もう一度選んでください。"]
        XCTAssertTrue(notSaved.waitForExistence(timeout: 15), "not saved over a changed row")
        shoot("category-conflict")
        let catConflict = try rows(label: "category-conflict")
        XCTAssertEqual(catConflict[cat]?["category"], "hobby")
        XCTAssertEqual(catConflict[cat]?["updated_at"], stamp, "the app did not write")
        assertUnchanged(catBefore, catConflict, except: [cat], "category conflict")
        if app.buttons["閉じる"].exists { app.buttons["閉じる"].tap() }
        Thread.sleep(forTimeInterval: 0.8)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["荷物"].waitForExistence(timeout: 10))
    }

    private func overAThousand(_ app: XCUIApplication) throws {
        let expect = try helper(["op": "expect"])
        let counts = try XCTUnwrap(expect["counts"] as? [String: Int])
        record("expect-bulk", "total \(expect["total"] ?? "?") \(counts.description)")
        XCTAssertGreaterThan(expect["total"] as? Int ?? 0, 1000)
        let shown = headerCounts(app, ["要確認", "配達中", "もうすぐ届く", "注文中"])
        for (header, key) in [("要確認", "toCheck"), ("配達中", "delivering"), ("もうすぐ届く", "soon"), ("注文中", "ordered")] {
            XCTAssertEqual(shown[header], counts[key], header)
            record("count-bulk-\(key)", "ui=\(shown[header].map(String.init) ?? "nil") db=\(counts[key] ?? -1)")
        }
        shoot("bulk-ordered")
    }

    // MARK: list helpers

    private func swipeDelivered(_ app: XCUIApplication, _ name: String) throws {
        let card = app.staticTexts[name]
        XCTAssertTrue(scrollTo(app, card), name)
        card.swipeLeft()
        let arrived = app.buttons["届いた"]
        if arrived.waitForExistence(timeout: 3) { arrived.tap() }
    }

    private func tapUndo(_ app: XCUIApplication, _ toast: XCUIElement) {
        let undo = app.buttons["元に戻す"]
        if undo.exists {
            undo.tap()
        } else {
            // The toast is one combined element: its button is at the trailing end.
            let f = toast.frame
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.maxX - 44, dy: f.midY)).tap()
        }
    }

    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func waitGone(_ element: XCUIElement, _ timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if !element.exists { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return !element.exists
    }

    private func listView(_ app: XCUIApplication) -> XCUIElement { app.collectionViews.firstMatch }

    private func scrollToTop(_ app: XCUIApplication) {
        let add = app.buttons["＋ 登録"]
        for _ in 0..<40 {
            if add.exists && add.isHittable { return }
            drag(app, from: 0.3, to: 0.85)
        }
    }

    /// Scrolls down (from where the list is) until the element is on screen.
    @discardableResult
    private func scrollTo(_ app: XCUIApplication, _ element: XCUIElement, max: Int = 40) -> Bool {
        for _ in 0..<max {
            if element.exists && element.isHittable && visible(app, element) { return true }
            drag(app, from: 0.75, to: 0.4)
        }
        return element.exists && element.isHittable
    }

    private func visible(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        let w = app.windows.firstMatch.frame
        let f = element.frame
        return f.minY > w.minY + 100 && f.maxY < w.maxY - 120
    }

    /// `slow`: no fling after the finger lifts, so the list moves by the drag only.
    private func drag(_ app: XCUIApplication, from: CGFloat, to: CGFloat, slow: Bool = false) {
        let list = listView(app)
        let target = list.exists ? list : app.windows.firstMatch
        let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: from))
        let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: to))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: slow ? .slow : .default, thenHoldForDuration: slow ? 0.4 : 0.1)
    }

    private func pullToRefresh(_ app: XCUIApplication) {
        let w = app.windows.firstMatch
        w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            .press(forDuration: 0.1, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)), withVelocity: .slow, thenHoldForDuration: 0.5)
        Thread.sleep(forTimeInterval: 1.5)
    }

    /// Every static text on screen (one snapshot of the tree, not one query per element).
    private func texts(_ app: XCUIApplication) -> [(label: String, frame: CGRect)] {
        guard let root = try? app.snapshot() else { return [] }
        var out: [(label: String, frame: CGRect)] = []
        func walk(_ e: any XCUIElementSnapshot) {
            if e.elementType == .staticText { out.append((e.label, e.frame)) }
            for c in e.children { walk(c) }
        }
        walk(root)
        return out
    }

    /// The numbers beside the given section titles, read in one pass down from the top (stops when
    /// all are found or after 25 drags).
    private func headerCounts(_ app: XCUIApplication, _ headers: [String]) -> [String: Int] {
        scrollToTop(app)
        let window = app.windows.firstMatch.frame
        var found: [String: Int] = [:]
        for _ in 0..<25 {
            let all = texts(app)
            for h in all where headers.contains(h.label) && found[h.label] == nil && h.frame.minY > window.minY + 60 && h.frame.maxY < window.maxY - 60 {
                // The number may be shown with a grouping comma (「1,053」): recorded as shown.
                for n in all where n.label.wholeMatch(of: /[0-9,]+/) != nil {
                    if abs(n.frame.midY - h.frame.midY) < 8, n.frame.minX >= h.frame.maxX, n.frame.minX - h.frame.maxX < 30 {
                        found[h.label] = Int(n.label.replacingOccurrences(of: ",", with: ""))
                        record("header-label-\(h.label)", "「\(n.label)」")
                    }
                }
            }
            if found.count == headers.count { break }
            drag(app, from: 0.75, to: 0.3, slow: true)
        }
        return found
    }

    /// The number beside a section's title (「配達中 2」), nil when the title is not found.
    private func headerCount(_ app: XCUIApplication, _ header: String, scroll: Bool) -> Int? {
        if scroll { scrollToTop(app) }
        let window = app.windows.firstMatch.frame
        for _ in 0..<(scroll ? 40 : 1) {
            let all = texts(app)
            for h in all where h.label == header && h.frame.minY > window.minY + 60 && h.frame.maxY < window.maxY - 60 {
                for n in all where n.label.wholeMatch(of: /[0-9]+/) != nil {
                    if abs(n.frame.midY - h.frame.midY) < 8, n.frame.minX >= h.frame.maxX, n.frame.minX - h.frame.maxX < 30 { return Int(n.label) }
                }
            }
            if !scroll { break }
            drag(app, from: 0.75, to: 0.4)
        }
        return nil
    }

    /// 「1,050 件」 beside a page link, nil when the link has no count.
    private func pageLinkCount(_ app: XCUIApplication, _ link: String) -> Int? {
        guard scrollTo(app, app.staticTexts[link], max: 60) else { return nil }
        let all = texts(app)
        guard let l = all.first(where: { $0.label == link }) else { return nil }
        for n in all where abs(n.frame.midY - l.frame.midY) < 8 {
            if let m = n.label.wholeMatch(of: /([0-9,]+) 件/) { return Int(m.1.replacingOccurrences(of: ",", with: "")) }
        }
        let button = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", link)).firstMatch
        if let m = button.label.firstMatch(of: /([0-9,]+) 件/) { return Int(m.1.replacingOccurrences(of: ",", with: "")) }
        return nil
    }

    /// Scrolls the whole list and checks that the cards come in the expected order. Titles that
    /// appear more than once (「品名の記載なし」) are left out of the order check.
    private func checkOrder(_ app: XCUIApplication, expected: [String], label: String) throws {
        var counts: [String: Int] = [:]
        for t in expected { counts[t, default: 0] += 1 }
        let unique = expected.filter { counts[$0] == 1 }
        let index = Dictionary(uniqueKeysWithValues: unique.enumerated().map { ($1, $0) })
        scrollToTop(app)
        var seen = Set<String>()
        var outOfOrder: [String] = []
        let end = app.staticTexts["届いた荷物"]
        for step in 0..<60 {
            let onScreen = texts(app)
                .filter { index[$0.label] != nil }
                .sorted { $0.frame.minY < $1.frame.minY }
                .map(\.label)
            var last = -1
            for t in onScreen {
                let i = index[t]!
                if i < last { outOfOrder.append("\(t) (screen \(step))") }
                last = max(last, i)
                seen.insert(t)
            }
            if end.exists && end.isHittable && visible(app, end) { break }
            drag(app, from: 0.75, to: 0.4)
        }
        let missing = unique.filter { !seen.contains($0) }
        XCTAssertTrue(outOfOrder.isEmpty, "out of order: \(outOfOrder)")
        XCTAssertTrue(missing.isEmpty, "not seen: \(missing)")
        record("order-\(label)", "unique \(unique.count), seen \(seen.count), out of order \(outOfOrder.count), missing \(missing.count)")
    }

    // MARK: the helper on the Mac

    @discardableResult
    private func helper(_ body: [String: Any], timeout: TimeInterval = 60) throws -> [String: Any] {
        seq += 1
        let name = "\(run)-\(String(format: "%04d", seq))"
        let tmp = ipc.appendingPathComponent("tmp-\(name)")
        try JSONSerialization.data(withJSONObject: body).write(to: tmp)
        try FileManager.default.moveItem(at: tmp, to: ipc.appendingPathComponent("req-\(name).json"))
        let res = ipc.appendingPathComponent("res-\(name).json")
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if let data = try? Data(contentsOf: res), let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let error = obj["error"] as? String {
                    XCTFail("helper \(body["op"] ?? ""): \(error)")
                    throw HelperError.failed(error)
                }
                return obj
            }
            Thread.sleep(forTimeInterval: 0.15)
        }
        XCTFail("helper did not answer \(body)")
        throw HelperError.noAnswer
    }

    private enum HelperError: Error { case failed(String), noAnswer }

    /// The 【試験】 rows (not the 一括 ones): title → status, category, category_source, updated_at.
    private func rows(label: String) throws -> [String: [String: String]] {
        let res = try helper(["op": "snap", "label": label])
        let raw = try XCTUnwrap(res["rows"] as? [String: [String: Any]])
        return raw.mapValues { $0.compactMapValues { $0 as? String } }
    }

    /// Reads the rows until `done` holds (a write may land just after the screen changes).
    private func waitRows(label: String, timeout: TimeInterval = 15, _ done: ([String: [String: String]]) -> Bool) throws -> [String: [String: String]] {
        let end = Date().addingTimeInterval(timeout)
        var r = try rows(label: label)
        while !done(r) && Date() < end {
            Thread.sleep(forTimeInterval: 1)
            r = try rows(label: label)
        }
        return r
    }

    private func assertUnchanged(_ a: [String: [String: String]], _ b: [String: [String: String]], except: Set<String>, _ what: String) {
        XCTAssertEqual(Set(a.keys), Set(b.keys), "\(what): the same rows")
        var changed: [String] = []
        for (title, row) in a where !except.contains(title) {
            if b[title] != row { changed.append(title) }
        }
        XCTAssertTrue(changed.isEmpty, "\(what): other rows changed: \(changed)")
        record("unchanged-\(what)", "others \(a.count - except.count), changed \(changed.count)")
    }

    // MARK: output

    private func record(_ key: String, _ value: String) {
        print("QA-REAL \(key): \(value)")
    }

    private func shoot(_ name: String) {
        guard let dir = shots else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        Thread.sleep(forTimeInterval: 0.6)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("qa-real-\(name).png"))
    }
}
