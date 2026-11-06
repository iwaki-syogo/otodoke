import Foundation
import Testing
@testable import Otodoke

// Review fixes of the M2 password round (codex-m2pw): B1-2 (a sealed mail that failed opens again on the
// next press), B2-1 (a cut-off read of the delivered / cancelled page is not a failure and is read again on
// coming back, as CX-f2), B2-2 (the delivered page's filter cache and pickers compare UTF-16 units, as
// N-new1), A3-2 (the weak-password check's white space is JavaScript's \s, not Unicode's White_Space).

// MARK: - [B1-2] a sealed mail that failed is opened again by the next press

@Suite("M2pw: a failed sealed mail opens again (B1-2)", .serialized)
@MainActor
struct M2pwSealedRetryTests {
    @Test func aLostEnvelopeReadOpensOnTheNextPressOnceTheNetworkIsBack() async throws {
        // Only the first envelope read fails (the network down); the second goes through.
        let w = try await SealedMailTests().world(faults: { await $0.fail("GET", "emails", nth: 1, with: .transport(.notConnectedToInternet)) })
        w.unlock.plantVaultKey()
        #expect(w.detail.startsOpening(emailID: w.emailID))
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .failed)
        #expect(w.detail.heldPlaintextCount == 0)

        // The press of 「元メールを見る」 again (the card folded and opened): the screen asks the model.
        #expect(w.detail.startsOpening(emailID: w.emailID))
        w.detail.startOpeningSealed(emailID: w.emailID)
        let detail = w.detail
        let emailID = w.emailID
        let opened = SealedMailTests().expectedOpened(w.unlock.v)
        #expect(await waitFor { await detail.sealedState(emailID: emailID) == .opened(opened) }, "\(w.detail.sealedState(emailID: w.emailID))")
        #expect(await w.fake.count("GET", "emails") == 2)
        #expect(w.detail.heldPlaintextCount == 1)
        // Opened: a press only folds it (no read again).
        #expect(w.detail.startsOpening(emailID: w.emailID) == false)
    }

    @Test func aKeyRowThatCouldNotBeReadIsReadAgainOnTheNextPress() async throws {
        let v = try EnvelopeVector()
        var o = v.envelopeObject
        o["kid"] = SealedMailTests.otherKid
        let w = try await SealedMailTests().world(envelope: JSONValue(any: o), faults: { await $0.fail("GET", "user_keys", nth: 1, with: .http(500)) })
        w.unlock.plantVaultKey()
        let model = UnlockModel(store: w.unlock.store, keys: MailKeyReader(provider: w.auth.provider), vault: w.unlock.vault, policy: w.unlock.policy, deriver: w.unlock.deriver)
        w.detail.unlock = model
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .readFailed)
        let keyReads = await w.fake.count("GET", "user_keys")

        #expect(w.detail.startsOpening(emailID: w.emailID))
        await w.detail.openSealed(emailID: w.emailID)
        // Read again: the key row now says the mail is of an older passphrase.
        #expect(await w.fake.count("GET", "user_keys") > keyReads)
        #expect(w.detail.sealedState(emailID: w.emailID) == .oldKey)
    }

    @Test func aPressWhileItIsOpeningStartsNothingMore() async throws {
        let gate = Gate()
        let w = try await SealedMailTests().world(faults: { await $0.fail("GET", "emails", nth: 1, with: .hold(gate)) })
        defer { gate.open() }
        w.unlock.plantVaultKey()
        let detail = w.detail
        let emailID = w.emailID
        let first = Task { await detail.openSealed(emailID: emailID) }
        let fake = w.fake
        #expect(await waitFor { await fake.count("GET", "emails") == 1 })
        #expect(w.detail.sealedState(emailID: w.emailID) == .opening)
        #expect(w.detail.startsOpening(emailID: w.emailID) == false)
        // Even when called anyway (a second task), nothing more is read.
        await w.detail.openSealed(emailID: w.emailID)
        #expect(await w.fake.count("GET", "emails") == 1)
        gate.open()
        await first.value
        #expect(w.detail.sealedState(emailID: w.emailID) == .opened(SealedMailTests().expectedOpened(w.unlock.v)))
        #expect(await w.fake.count("GET", "emails") == 1)
    }

    @Test func theStatesAPressStartsOpeningFrom() async throws {
        // Negative controls around the two states that now start again.
        let w = try await SealedMailTests().world(envelope: .null)
        w.unlock.plantVaultKey()
        #expect(w.detail.startsOpening(emailID: w.emailID))
        await w.detail.openSealed(emailID: w.emailID)
        #expect(w.detail.sealedState(emailID: w.emailID) == .failed)
        #expect(w.detail.startsOpening(emailID: w.emailID))
        // An older passphrase's mail: a press does not read it again (the passphrase is what is needed).
        let v = try EnvelopeVector()
        var o = v.envelopeObject
        o["kid"] = SealedMailTests.otherKid
        let old = try await SealedMailTests().world(envelope: JSONValue(any: o))
        old.unlock.plantVaultKey()
        await old.detail.openSealed(emailID: old.emailID)
        #expect(old.detail.sealedState(emailID: old.emailID) == .oldKey)
        #expect(old.detail.startsOpening(emailID: old.emailID) == false)
        // The key asked for: UnlockView opens it, not the press.
        let ask = try await SealedMailTests().world()
        await ask.detail.openSealed(emailID: ask.emailID)
        #expect(ask.detail.sealedState(emailID: ask.emailID) == .unlocking)
        #expect(ask.detail.startsOpening(emailID: ask.emailID) == false)
    }
}

// MARK: - [B2-1] a cut-off read of the delivered / cancelled page

/// The page's .task is cancelled when the tab is left; the read then ends as a failure (URLSession's
/// cancelled). That is not 「読み込めませんでした」, and coming back reads again — also before the old read
/// has ended (CX-f2's order: start, cancel, shown again, the old read ends).
@Suite("M2pw: a cut-off read of the delivered and cancelled pages (B2-1)", .serialized)
@MainActor
struct M2pwStatusPageCutOffTests {
    /// A page model, its read once, then 「古くなった」 and a held read on the next appearance that ends cut off.
    enum Page: String, CaseIterable, Sendable { case delivered, cancelled }

    @MainActor
    final class Subject {
        let page: Page
        let delivered: DeliveredModel?
        let cancelled: CancelledModel?
        init(_ page: Page, _ w: StatusListsTests.World) {
            self.page = page
            delivered = page == .delivered ? DeliveredModel(reader: w.reader, changes: w.changes) : nil
            cancelled = page == .cancelled ? CancelledModel(reader: w.reader, changes: w.changes) : nil
        }
        func load() async { if let delivered { await delivered.load() } else { await cancelled?.load() } }
        func onAppear() async { if let delivered { await delivered.onAppear() } else { await cancelled?.onAppear() } }
        var titles: [String]? {
            if let delivered { return delivered.shown?.map { $0.title ?? "" } }
            return cancelled?.parcels?.value?.map { $0.title ?? "" }
        }
        var message: String? { delivered?.message ?? cancelled?.message }
        var failedText: String { page == .delivered ? DeliveredModel.failedText : CancelledModel.failedText }
        var isLoading: Bool { delivered?.isLoading ?? cancelled?.isLoading ?? false }
    }

    func world(_ page: Page, title: String = "前の品名", faults: (FakeSupabase) async -> Void = { _ in }) async throws -> StatusListsTests.World {
        try await StatusListsTests().world(parcels: [StatusListsTests.delivered(1, ["status": .string(page.rawValue), "title": .string(title)])], faults: faults)
    }

    /// Read once; then the title changes, 「古くなった」, and the next read is held until `gate` opens and then
    /// ends as URLSession's cancelled.
    func readThenStale(_ page: Page, gate: Gate) async throws -> (StatusListsTests.World, Subject, Int) {
        let w = try await world(page)
        let s = Subject(page, w)
        await s.load()
        #expect(s.titles == ["前の品名"])
        _ = await w.fake.touch("parcels", id: Rows.id(1), ["title": "新しい品名"])
        w.changes.publish()
        let reads = await w.fake.count("GET", "parcels")
        await w.fake.fail("GET", "parcels", nth: reads + 1, with: .holdThen(gate, .transport(.cancelled)))
        return (w, s, reads)
    }

    @Test(arguments: Page.allCases)
    func comingBackBeforeTheOldReadEndsReadsAgain(_ page: Page) async throws {
        let gate = Gate()
        defer { gate.open() }
        let (w, s, reads) = try await readThenStale(page, gate: gate)
        let fake = w.fake
        let first = Task { await s.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        first.cancel()
        // Back on the tab right away: the old read has not ended.
        await s.onAppear()
        #expect(await waitFor { await s.titles == ["新しい品名"] }, "\(page): \(String(describing: s.titles))")
        // The old read ends afterwards: it changes nothing.
        gate.open()
        await first.value
        #expect(s.titles == ["新しい品名"], "\(page)")
        #expect(s.message == nil, "\(page)")
        #expect(s.isLoading == false, "\(page)")
    }

    @Test(arguments: Page.allCases)
    func aCutOffReadIsNotAFailureAndIsReadAgainOnComingBack(_ page: Page) async throws {
        let gate = Gate()
        defer { gate.open() }
        let (w, s, reads) = try await readThenStale(page, gate: gate)
        let fake = w.fake
        let first = Task { await s.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        first.cancel()
        gate.open()
        await first.value
        // Dropped: the last read stays, no 「読み込めませんでした」.
        #expect(s.message != s.failedText, "\(page)")
        #expect(s.titles == ["前の品名"], "\(page)")
        #expect(s.isLoading == false, "\(page)")
        // Shown again: read again.
        await s.onAppear()
        #expect(await fake.count("GET", "parcels") > reads + 1, "\(page)")
        #expect(s.titles == ["新しい品名"], "\(page)")
        #expect(s.message == nil, "\(page)")
    }

    @Test(arguments: Page.allCases)
    func aFailedReadIsReadAgainOnComingBack(_ page: Page) async throws {
        let w = try await world(page, faults: { await $0.fail("GET", "parcels", nth: 1, with: .http(500)) })
        let s = Subject(page, w)
        await s.onAppear()
        #expect(s.message == s.failedText, "\(page)")
        await s.onAppear()
        #expect(await w.fake.count("GET", "parcels") == 2, "\(page)")
        #expect(s.titles == ["前の品名"], "\(page)")
        #expect(s.message == nil, "\(page)")
    }

    /// Negative control: a read on the way that was not cut off is not started twice.
    @Test(arguments: Page.allCases)
    func aReadOnTheWayIsNotStartedTwice(_ page: Page) async throws {
        let gate = Gate()
        defer { gate.open() }
        let (w, s, reads) = try await readThenStale(page, gate: gate)
        let fake = w.fake
        // Not cut off: a second appearance while the read is held starts no other read.
        let first = Task { await s.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        await s.onAppear()
        #expect(await fake.count("GET", "parcels") == reads + 1, "\(page)")
        first.cancel()
        gate.open()
        await first.value
    }

    /// Negative control (N-new2's order): a cut-off read that a newer read superseded leaves no mark, so
    /// the next appearance does not read again.
    @Test(arguments: Page.allCases)
    func aSupersededCutOffReadLeavesNoMark(_ page: Page) async throws {
        let gate = Gate()
        defer { gate.open() }
        let (w, s, reads) = try await readThenStale(page, gate: gate)
        let fake = w.fake
        let first = Task { await s.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        first.cancel()
        await s.load()
        #expect(s.titles == ["新しい品名"], "\(page)")
        gate.open()
        await first.value
        let after = await fake.count("GET", "parcels")
        await s.onAppear()
        #expect(await fake.count("GET", "parcels") == after, "\(page)")
        #expect(s.titles == ["新しい品名"], "\(page)")
    }
}

// MARK: - [B2-2] the delivered page's shop compares UTF-16 units

/// "Caf\u{00E9}" (NFC) and "Cafe\u{0301}" (NFD) are two shops for the Web (=== on code units) and for
/// Delivered.filterDelivered / deliveredFilterOptions (JSText.equal); Swift's == says one.
@Suite("M2pw: the delivered page's shop compares UTF-16 units (B2-2)")
@MainActor
struct M2pwDeliveredShopKeyTests {
    static let nfc = "Caf\u{00E9}"
    static let nfd = "Cafe\u{0301}"

    @Test func theTrap() {
        #expect(Self.nfc == Self.nfd)
        #expect(JSText.equal(Self.nfc, Self.nfd) == false)
        #expect(DeliveredFilterValues(s: Self.nfc) == DeliveredFilterValues(s: Self.nfd))
    }

    @Test func eachShopChosenInTurnShowsOnlyItsParcels() async throws {
        let w = try await StatusListsTests().world(parcels: [
            StatusListsTests.delivered(1, ["shop": .string(Self.nfc), "ordered_at": "2026-11-01"]),
            StatusListsTests.delivered(2, ["shop": .string(Self.nfd), "ordered_at": "2026-11-02"]),
        ])
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.load()
        let shops = try #require(model.options?.shops)
        #expect(shops.count == 2)
        #expect(model.shown?.count == 2)
        for (shop, id) in [(Self.nfc, 1), (Self.nfd, 2), (Self.nfc, 1), (Self.nfd, 2)] {
            model.shop = shop
            #expect(model.shown?.map(\.id) == [Rows.id(id)], "\(Array(shop.unicodeScalars))")
            #expect(model.count == 1)
        }
        model.shop = ""
        #expect(model.shown?.count == 2)
    }

    @Test func thePickersTagsAndLabelTellTheTwoApart() {
        let choices: [(value: String, label: String)] = [(Self.nfc, "NFC"), (Self.nfd, "NFD")]
        #expect(Set(choices.map { DeliveredPickerKey.tag($0.value) }).count == 2)
        #expect(DeliveredPickerKey.label(selected: Self.nfc, choices: choices, all: "すべて") == "NFC")
        #expect(DeliveredPickerKey.label(selected: Self.nfd, choices: choices, all: "すべて") == "NFD")
        #expect(DeliveredPickerKey.label(selected: "", choices: choices, all: "すべて") == "すべて")
        #expect(DeliveredPickerKey.label(selected: "ほか", choices: choices, all: "すべて") == "すべて")
        // The tag goes back to the very same string (the units, not a look-alike).
        for value in [Self.nfc, Self.nfd, "", "テスト珈琲", "👍🏽店"] {
            #expect(Array(DeliveredPickerKey.value(DeliveredPickerKey.tag(value)).utf16) == Array(value.utf16))
        }
    }
}

// MARK: - [A3-2] the weak-password check's white space is JavaScript's \s

/// password-v1.ts isWeakPassword removes /[\d\s\p{P}\p{S}]/gu. JavaScript's \s is WhiteSpace + LineTerminator
/// (ECMA-262 §12.2, §12.3): it holds U+FEFF and not U+0085; Unicode's White_Space (Swift's isWhitespace) is the
/// other way round. The Web's answers were checked with Node: "password\u{FEFF}12" → letters "password" (weak);
/// "password\u{0085}12" → "password\u{0085}" (not weak).
@Suite("M2pw: the weak-password white space is JavaScript's (A3-2)")
struct M2pwPasswordWhiteSpaceTests {
    /// ECMAScript's \s (with the u flag), as code points.
    static let jsSpace: [UInt32] = [
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
        0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ]

    static func around(_ c: UInt32) -> String {
        "password" + String(Character(Unicode.Scalar(c)!)) + "12"
    }

    /// Every scalar: the table is exactly Node's /\s/u (the list above was printed by Node over 0...0x10FFFF),
    /// and the same set as String.prototype.trim's (JSText.isTrimmable: WhiteSpace + LineTerminator too).
    @Test func theTableIsJavaScriptsOverEveryScalar() {
        let expected = Set(Self.jsSpace)
        var found: [UInt32] = []
        var unlikeTrim: [UInt32] = []
        for value in UInt32(0)...0x10FFFF {
            guard let s = Unicode.Scalar(value) else { continue }
            let isSpace = PasswordRule.isJSWhiteSpace(s)
            if isSpace { found.append(value) }
            if isSpace != (value <= 0xFFFF && JSText.isTrimmable(UInt16(value))) { unlikeTrim.append(value) }
        }
        #expect(Set(found) == expected)
        #expect(found.count == expected.count)
        #expect(unlikeTrim.isEmpty, "\(unlikeTrim.map { String($0, radix: 16) })")
        // The trap: Unicode's White_Space differs exactly at these two.
        #expect(Unicode.Scalar(0x85)!.properties.isWhitespace && !PasswordRule.isJSWhiteSpace(Unicode.Scalar(0x85)!))
        #expect(!Unicode.Scalar(0xFEFF)!.properties.isWhitespace && PasswordRule.isJSWhiteSpace(Unicode.Scalar(0xFEFF)!))
    }

    @Test func theTwoCasesOfTheReview() {
        #expect(PasswordRule.problem(password: "password\u{FEFF}12", again: "password\u{FEFF}12") == LoginText.passwordWeak)
        #expect(PasswordRule.problem(password: "password\u{0085}12", again: "password\u{0085}12") == nil)
    }

    @Test(arguments: jsSpace)
    func everyJavaScriptSpaceIsTakenOut(_ c: UInt32) {
        let p = Self.around(c)
        #expect(PasswordRule.problem(password: p, again: p) == LoginText.passwordWeak, "U+\(String(c, radix: 16, uppercase: true))")
    }

    /// Not \s, and not P or S either (Cc, Cf, Mn): kept, so the word is no longer a common one, as on the Web.
    @Test(arguments: [UInt32(0x85), 0x180E, 0x200B, 0x200C, 0x200D, 0x2060, 0x1F])
    func whatJavaScriptDoesNotCallSpaceIsKept(_ c: UInt32) {
        let p = Self.around(c)
        #expect(PasswordRule.problem(password: p, again: p) == nil, "U+\(String(c, radix: 16, uppercase: true))")
    }
}
