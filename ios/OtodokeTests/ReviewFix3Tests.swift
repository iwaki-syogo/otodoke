import Foundation
import Testing
@testable import Otodoke

/// [Fix 3: CF1・CF2・CF3] A category is written only on the version shown, so a choice whose answer was
/// lost and that reaches the server late never overwrites a later one; 「すべて受取済にする」 holds the
/// rows it sends until their results are shown, so a swipe on one sends nothing meanwhile; the
/// fresh-install marker that cannot be made never leaves the next launch clearing a new session.
@Suite("Review fix 3", .serialized)
@MainActor
struct ReviewFix3Tests {
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    private func writer(_ fake: FakeSupabase) async throws -> ParcelWriter {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelWriter(provider: provider)
    }

    private func stored(_ fake: FakeSupabase, _ n: Int, _ column: String) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?[column]?.string
    }

    // MARK: CF1: the writer

    @Test func aCategoryIsWrittenOnlyOnTheVersionShown() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["category": "food", "category_source": "auto"])])
        let writer = try await writer(fake)
        let stamp = try #require(await stored(fake, 1, "updated_at"))

        let result = await writer.setCategory(ParcelVersion(id: Rows.id(1), status: "shipped", updatedAt: stamp), category: .hobby)
        guard case let .success(after) = result else {
            Issue.record("\(result)")
            return
        }
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        #expect(patch.query("id") == ["eq.\(Rows.id(1))"])
        #expect(patch.query("user_id") == ["eq.\(FakeSupabase.me)"])
        // Sent verbatim: the "+" and the microseconds survive.
        #expect(patch.query("updated_at") == ["eq.\(stamp)"])
        #expect(NSDictionary(dictionary: patch.jsonDictionary ?? [:]) == NSDictionary(dictionary: ["category": "hobby", "category_source": "user"]))
        #expect(after.updatedAt == (await stored(fake, 1, "updated_at")))

        // The version before that write is no longer the row: nothing is written.
        let stale = await writer.setCategory(ParcelVersion(id: Rows.id(1), status: "shipped", updatedAt: stamp), category: .daily)
        #expect(stale == .notUpdated(.conflict))
        #expect(await stored(fake, 1, "category") == "hobby")
    }

    @Test func aCategoryWithoutAVersionIsWrittenOnTheVersionReadJustBefore() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        let stamp = try #require(await stored(fake, 1, "updated_at"))
        guard case .success = await writer.setCategory(id: Rows.id(1), category: .beauty) else {
            Issue.record("not saved")
            return
        }
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        #expect(patch.query("updated_at") == ["eq.\(stamp)"])
        #expect(patch.query("user_id") == ["eq.\(FakeSupabase.me)"])
    }

    @Test func aCategoryWithAnEmptyVersionIsRefusedWithoutSending() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        #expect(await writer.setCategory(ParcelVersion(id: Rows.id(1), status: "shipped", updatedAt: ""), category: .food) == .notUpdated(.invalidInput))
        #expect(await fake.count("PATCH", "parcels") == 0)
    }

    // MARK: CF1: the detail

    private func seededDetail() async throws -> (FakeSupabase, ParcelDetailModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "category": "food"])])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        return (fake, model)
    }

    @Test func aLostChoiceThatArrivesLateNeverOverwritesALaterOne() async throws {
        let (fake, model) = try await seededDetail()
        let late = Gate()
        let handled = Gate()
        // Choice A: the device times out while the server still holds the request.
        await fake.fail("PATCH", "parcels", with: .lostThenLate(late, .timedOut, handled: handled))
        #expect(await model.setCategory(.hobby) == false)
        // The read after it succeeds and shows the row as it was: no longer unconfirmed.
        #expect(model.isUnconfirmed == false)
        #expect(model.shownCategory == .food)

        // Choice B is saved.
        #expect(await model.setCategory(.daily) == true)
        #expect(await stored(fake, 1, "category") == "daily")

        // A reaches the database now: on the version it was chosen on, so 0 rows.
        late.open()
        await handled.wait()
        #expect(await fake.count("PATCH", "parcels") == 2)
        #expect(await stored(fake, 1, "category") == "daily")
    }

    @Test func aChoiceOnAParcelChangedMeanwhileReadsItAgainAndSaysSo() async throws {
        let (fake, model) = try await seededDetail()
        await fake.touch("parcels", id: Rows.id(1), ["category": "beauty"])
        #expect(await model.setCategory(.hobby) == false)
        #expect(await stored(fake, 1, "category") == "beauty")
        #expect(model.shownCategory == .beauty)
        #expect(model.storedCategory == .beauty)
        #expect(model.categoryError == "保存されていませんでした。もう一度選んでください。")
        // On the version read now, the choice goes through.
        #expect(await model.setCategory(.hobby) == true)
        #expect(await stored(fake, 1, "category") == "hobby")
        #expect(model.categoryError == nil)
    }

    // MARK: CF2

    nonisolated private static let isListRead: @Sendable (StubRequest) -> Bool = { r in
        r.method == "GET" && r.path == "/rest/v1/parcels" && r.query("status").isEmpty
    }

    private func makeList(_ fake: FakeSupabase) async throws -> ParcelListModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelListModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider),
            today: { "2026-11-04" },
            now: { Self.now },
            sleep: ControlledSleeper().sleep
        )
    }

    @Test func aSwipeDuringDeliverAllSendsNothingForItsRows() async throws {
        let fake = FakeSupabase.make()
        // 1: もうすぐ届く. 4, 7, 8: 要確認, sent in that order.
        await fake.insert("parcels", [
            Rows.parcel(1, ["expected_date": "2026-11-05"]),
            Rows.parcel(4, ["expected_date": "2026-10-01"]),
            Rows.parcel(7, ["expected_date": "2026-10-02", "status": "ordered"]),
            Rows.parcel(8, ["expected_date": "2026-10-03"]),
        ])
        let model = try await makeList(fake)
        await model.load()
        let gate = Gate()
        // A (4): saved, answer lost. B (7): waiting for its answer.
        await fake.fail("PATCH", "parcels", nth: 1, with: .applyThenDrop(.networkConnectionLost))
        await fake.fail("PATCH", "parcels", nth: 2, with: .hold(gate))
        let task = Task { await model.deliverAll() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 2 })
        #expect(model.saving == [Rows.id(4), Rows.id(7), Rows.id(8)])

        // A swipe on A (unknown), and on C (8, not sent yet): nothing is sent.
        await model.markDelivered(id: Rows.id(4))
        await model.markDelivered(id: Rows.id(8))
        #expect(await fake.count("PATCH", "parcels") == 2)
        // A row outside the bulk is still swiped as usual.
        await model.markDelivered(id: Rows.id(1))
        #expect(await fake.count("PATCH", "parcels") == 3)

        gate.open()
        await task.value
        #expect(await fake.count("PATCH", "parcels") == 4)
        #expect(model.saving.isEmpty)
        #expect(model.unconfirmed.isEmpty)
        #expect(await stored(fake, 4, "status") == "delivered")
        #expect(await stored(fake, 7, "status") == "delivered")
        #expect(await stored(fake, 8, "status") == "delivered")
    }

    // MARK: CF3

    private func scratch() -> (root: URL, keychain: KeychainSessionStorage) {
        let root = FileManager.default.temporaryDirectory.appending(path: "otodoke-fresh3-\(UUID().uuidString)", directoryHint: .isDirectory)
        return (root, KeychainSessionStorage(service: "test.otodoke.fresh3.\(UUID().uuidString)"))
    }

    @Test func aMarkerFolderThatCannotBeMadeLeavesTheSessionAlone() throws {
        let (root, keychain) = scratch()
        defer {
            keychain.removeAll()
            try? FileManager.default.removeItem(at: root)
        }
        // "Application Support" is a file here: the folder cannot be made.
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let support = root.appending(path: "Application Support", directoryHint: .notDirectory)
        #expect(FileManager.default.createFile(atPath: support.path(percentEncoded: false), contents: Data("x".utf8)))
        let marker = support.appending(path: "installed", directoryHint: .notDirectory)
        try keychain.store(key: "sb-test-auth-token", value: Data("signed in".utf8))

        #expect(FreshInstall.prepare(marker: marker, keychain: keychain) == .markerFailed)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == Data("signed in".utf8))
        // The next launch does not take the session for a leftover either.
        #expect(FreshInstall.clearLeftoverSession(marker: marker, keychain: keychain) == false)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == Data("signed in".utf8))
    }

    @Test func aMarkerFileThatCannotBeWrittenLeavesTheSessionAlone() throws {
        let (root, keychain) = scratch()
        let support = root.appending(path: "Application Support", directoryHint: .isDirectory)
        defer {
            keychain.removeAll()
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: support.path(percentEncoded: false))
            try? FileManager.default.removeItem(at: root)
        }
        // The folder is there but read-only: the file cannot be created.
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: support.path(percentEncoded: false))
        let marker = support.appending(path: "installed", directoryHint: .notDirectory)
        try keychain.store(key: "sb-test-auth-token", value: Data("signed in".utf8))

        #expect(FreshInstall.prepare(marker: marker, keychain: keychain) == .markerFailed)
        #expect(!FileManager.default.fileExists(atPath: marker.path(percentEncoded: false)))
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == Data("signed in".utf8))
        #expect(FreshInstall.prepare(marker: marker, keychain: keychain) == .markerFailed)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == Data("signed in".utf8))

        // Once the marker can be written, the leftovers go once, and a later session stays.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: support.path(percentEncoded: false))
        #expect(FreshInstall.prepare(marker: marker, keychain: keychain) == .cleared)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == nil)
        try keychain.store(key: "sb-test-auth-token", value: Data("signed in again".utf8))
        #expect(FreshInstall.prepare(marker: marker, keychain: keychain) == .installed)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == Data("signed in again".utf8))
    }
}
