import Foundation
import SwiftUI
import Testing
@testable import Otodoke

/// [Batch 2, task 17 reads, task 18] A sealed mail opened on the detail screen: Face ID or the passphrase, then
/// body_envelope read (only now) and opened with the key; what it shows for each outcome (opened, could not
/// be read, null, not an envelope, no body, an older passphrase's mail); the bodies hidden when the scene goes
/// inactive and dropped in the background (CX2) and at sign-out. The vector's ids are FakeSupabase.me and its
/// email id, so the vector's envelope opens here as stored.
@Suite("Sealed mail on the detail (batch 2, task 18)")
@MainActor
struct SealedMailTests {
    nonisolated static let today = "2026-11-06"
    static let otherKid = "0123456789abcdef0123456789abcdef"

    struct World {
        let fake: FakeSupabase
        let auth: AuthService
        let unlock: UnlockWorld
        let detail: ParcelDetailModel
        let emailID: String
    }

    /// One parcel with one sealed mail (the vector's), its envelope in emails.body_envelope, the key row.
    func world(envelope: JSONValue? = nil, keyRows: Bool = true, faults: (FakeSupabase) async -> Void = { _ in }) async throws -> World {
        let v = try EnvelopeVector()
        #expect(v.userID == FakeSupabase.me)
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let embedded = Rows.email(1, [
            "id": .string(v.emailID), "subject": nil, "from_address": nil, "from_name": nil, "text_body": nil, "html_body": nil,
            "body_state": "sealed", "from_domain": "example.test",
        ])
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: embedded, ["email_id": .string(v.emailID)])])
        await fake.insert("emails", [[
            "id": .string(v.emailID), "user_id": .string(FakeSupabase.me), "body_state": "sealed",
            "body_envelope": envelope ?? JSONValue(any: v.envelopeObject),
            "subject": nil, "text_body": nil, "html_body": nil, "sent_at": "2026-11-01T00:00:00+00:00",
        ]])
        if keyRows { await fake.insert("user_keys", [v.keyRow(userID: FakeSupabase.me)]) }
        await faults(fake)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let u = try UnlockWorld(session: auth.session)
        auth.cleanup = u.store
        let detail = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { Self.today })
        detail.unlock = u.model
        detail.mailKeys = MailKeyReader(provider: provider)
        u.store.hold(detail)
        await detail.load()
        return World(fake: fake, auth: auth, unlock: u, detail: detail, emailID: v.emailID)
    }

    func expectedOpened(_ v: EnvelopeVector) -> OpenedMail {
        OpenedMail(subject: v.plaintext.subject, fromText: "テスト店 <shop@example.test>", body: JSText.trim(v.plaintext.text ?? ""))
    }

    // MARK: MailKeyReader

    @Test func theKeyRowIsTheOneInUseOfMine() async throws {
        let v = try EnvelopeVector()
        let fake = FakeSupabase.make()
        var retired = v.keyRow(userID: FakeSupabase.me)
        retired["key_id"] = .string(Self.otherKid)
        retired["retired_at"] = "2026-11-05T00:00:00+00:00"
        var notYet = v.keyRow(userID: FakeSupabase.me, activated: false)
        notYet["key_id"] = "ffffffffffffffffffffffffffffffff"
        await fake.insert("user_keys", [retired, notYet, v.keyRow(userID: FakeSupabase.me)])
        let (provider, _) = try await TestSession.signedIn(fake)
        let reader = MailKeyReader(provider: provider)
        #expect(await reader.currentKey() == .loaded(v.row()))
        let q = try #require(await fake.requests("GET", "user_keys").last)
        #expect(q.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(q.query("activated_at") == ["not.is.null"])
        #expect(q.query("retired_at") == ["is.null"])
        let select = q.query("select").first ?? ""
        for column in ["key_id", "public_key", "wrapped_private_key", "wrap_iv", "kdf_salt", "kdf_iterations"] {
            #expect(select.contains(column), "\(column)")
        }
    }

    @Test func twoKeysInUseOrAFailedReadIsFailed() async throws {
        let v = try EnvelopeVector()
        let two = FakeSupabase.make()
        await two.insert("user_keys", [v.keyRow(userID: FakeSupabase.me), v.keyRow(userID: FakeSupabase.me)])
        let (p2, _) = try await TestSession.signedIn(two)
        #expect(await MailKeyReader(provider: p2).currentKey() == .failed)

        let down = FakeSupabase.make()
        await down.fail("GET", "user_keys", with: .http(500))
        let (p3, _) = try await TestSession.signedIn(down)
        #expect(await MailKeyReader(provider: p3).currentKey() == .failed)

        let none = FakeSupabase.make()
        let (p4, _) = try await TestSession.signedIn(none)
        #expect(await MailKeyReader(provider: p4).currentKey() == .loaded(nil))
    }

    @Test func theEnvelopeIsReadOnlyForASealedMailOfMine() async throws {
        let v = try EnvelopeVector()
        let w = try await world()
        let reader = MailKeyReader(provider: w.auth.provider)
        let read = await reader.envelope(emailID: v.emailID)
        let data = try #require(read.value ?? nil)
        #expect(try Envelope.parse(jsonData: data) == Envelope.parse(jsonData: v.envelopeJSON))
        let q = try #require(await w.fake.requests("GET", "emails").last)
        #expect(q.query("id") == ["eq.\(v.emailID)"])
        #expect(q.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(q.query("body_state") == ["eq.sealed"])
        #expect(q.query("select").first?.contains("body_envelope") == true)
        #expect(await reader.envelope(emailID: Rows.id(99)) == .loaded(nil))
    }

    @Test func theDetailDoesNotReadTheEnvelopeUntilOpened() async throws {
        let w = try await world()
        #expect(await w.fake.count("GET", "emails") == 0)
        #expect(w.detail.timeline?.value?.first?.emailID == w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .closed)
    }

    // MARK: opening

    @Test func faceIDOpensItAndTheSubjectAndSenderShow() async throws {
        let w = try await world()
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .opened(expectedOpened(w.unlock.v)))
        #expect(w.detail.heldPlaintextCount == 1)
        #expect(await w.fake.count("GET", "emails") == 1)
    }

    @Test func withoutAKeyThePassphraseIsAskedThenItOpens() async throws {
        let w = try await world()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .unlocking)
        #expect(await w.fake.count("GET", "emails") == 0)

        await w.detail.submitPassphrase("ちがう合言葉ちがう合言葉", emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .unlocking)
        #expect(w.unlock.model.message == UnlockModel.wrongPassphraseText)

        await w.detail.submitPassphrase(w.unlock.v.passphrase, emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .opened(expectedOpened(w.unlock.v)))
    }

    @Test func aCancelledFaceIDAsksForThePassphrase() async throws {
        let w = try await world()
        w.unlock.plantVaultKey()
        w.unlock.keychain.forceRead(errSecUserCanceled)
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .unlocking)
    }

    @Test func anEnvelopeThatCannotBeReadIsNotOpened() async throws {
        let w = try await world(faults: { await $0.fail("GET", "emails", with: .http(500)) })
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .failed)
        #expect(w.detail.heldPlaintextCount == 0)
    }

    @Test func aNullEnvelopeIsNotOpened() async throws {
        let w = try await world(envelope: .null)
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .failed)
    }

    @Test(arguments: ["no ct", "v 2", "not an object", "ct changed"])
    func anEnvelopeOfTheWrongShapeIsNotOpened(_ name: String) async throws {
        let v = try EnvelopeVector()
        var o = v.envelopeObject
        let value: JSONValue
        switch name {
        case "no ct": o["ct"] = nil; value = JSONValue(any: o)
        case "v 2": o["v"] = 2; value = JSONValue(any: o)
        case "not an object": value = "envelope"
        default: o["ct"] = v.flipped("ct", at: 3); value = JSONValue(any: o)
        }
        let w = try await world(envelope: value)
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .failed, "\(name)")
    }

    @Test func aMailOfAnOlderPassphraseSaysSoAndKeepsTheDeviceKey() async throws {
        let v = try EnvelopeVector()
        var o = v.envelopeObject
        o["kid"] = Self.otherKid
        let w = try await world(envelope: JSONValue(any: o))
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .oldKey)
        #expect(w.unlock.vaultCount == 1)
    }

    @Test func aMailOfAnotherKidWhenTheKeyRowCannotBeReadAgain() async throws {
        let v = try EnvelopeVector()
        var o = v.envelopeObject
        o["kid"] = Self.otherKid
        let w = try await world(envelope: JSONValue(any: o), faults: { await $0.fail("GET", "user_keys", with: .http(500)) })
        w.unlock.plantVaultKey()
        // UnlockWorld's own reader is not the one hitting FakeSupabase: use the app's reader for the key row.
        let model = UnlockModel(store: w.unlock.store, keys: MailKeyReader(provider: w.auth.provider), vault: w.unlock.vault, policy: w.unlock.policy, deriver: w.unlock.deriver)
        w.detail.unlock = model
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .readFailed)
        #expect(w.unlock.vaultCount == 1)
    }

    // MARK: what the opened mail shows

    @Test func theBodyIsTheTextTrimmedElseTheHTMLAsTextElseNothing() {
        let text = MailBody.opened(MailPlaintext(subject: "件", fromName: "店", fromAddress: "a@example.test", text: "  本文\n ", html: "<p>x</p>"))
        #expect(text == OpenedMail(subject: "件", fromText: "店 <a@example.test>", body: "本文"))
        let html = MailBody.opened(MailPlaintext(subject: nil, fromName: nil, fromAddress: "a@example.test", text: " \n ", html: "<p>こんにちは</p><p>二行目</p>"))
        #expect(html.body == HtmlText.htmlToText("<p>こんにちは</p><p>二行目</p>"))
        #expect(html.fromText == "a@example.test")
        #expect(html.subject == nil)
        #expect(MailBody.opened(MailPlaintext(subject: "s", fromName: "", fromAddress: "b@example.test", text: nil, html: nil)) == OpenedMail(subject: "s", fromText: "b@example.test", body: ""))
        #expect(MailBody.opened(MailPlaintext(subject: "s", fromName: nil, fromAddress: nil, text: "", html: "")).body == "")
        #expect(MailBody.noBody == "本文はありません。")
    }

    // MARK: hidden, dropped (CX2), signed out

    @Test func inactiveHidesTheBodyAndActiveShowsItAgain() async throws {
        let w = try await world()
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.isBodyHidden == false)
        w.detail.sceneChanged(.inactive)
        #expect(w.detail.isBodyHidden)
        w.detail.sceneChanged(.active)
        #expect(w.detail.isBodyHidden == false)
        #expect(w.detail.sealedState(emailID: w.emailID) == .opened(expectedOpened(w.unlock.v)))
    }

    @Test func theBackgroundDropsTheOpenedMail() async throws {
        let w = try await world()
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.heldPlaintextCount == 1)
        w.unlock.store.wentToBackground()
        #expect(w.detail.heldPlaintextCount == 0)
        #expect(w.detail.sealedState(emailID: w.emailID) == .closed)
    }

    @Test func aMailOpenedAfterTheBackgroundIsNotShown() async throws {
        let gate = Gate()
        let w = try await world(faults: { await $0.fail("GET", "emails", with: .hold(gate)) })
        defer { gate.open() }
        w.unlock.plantVaultKey()
        // The key opens first (memory), then the envelope read is held.
        _ = await w.unlock.model.key()
        let open = Task { await w.detail.openSealed(emailID: w.emailID) }
        let fake = w.fake
        #expect(await waitFor { await fake.count("GET", "emails") == 1 })
        #expect(w.detail.sealedState(emailID: w.emailID) == .opening)
        w.unlock.store.wentToBackground()
        gate.open()
        await open.value
        #expect(w.detail.heldPlaintextCount == 0)
        if case .opened = w.detail.sealedState(emailID: w.emailID) {
            Issue.record("the mail was shown after the background")
        }
    }

    @Test func signingOutDropsTheOpenedMail() async throws {
        let w = try await world()
        w.unlock.plantVaultKey()
        await w.detail.openSealed(emailID: w.emailID)
        await w.auth.signOut()
        #expect(w.detail.heldPlaintextCount == 0)
        #expect(w.detail.sealedState(emailID: w.emailID) == .closed)
        #expect(w.unlock.vaultCount == 0)
    }
}
