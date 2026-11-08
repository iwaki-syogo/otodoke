import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 3] 「メールの履歴」 by emails.body_state, as src/app/app/parcels/[id]/page.tsx (2541793)
/// branches (copied by hand: the branches live in the page, not in lib). Sealed and dropped mails have
/// subject, from_*, text_body and html_body null; none of them may read 「本文はありません。」.
@Suite("Mail body by body_state (batch 2, task 3)")
struct MailBodyTests {
    static let sealedHeadline = "🔒 暗号化されたメール"
    static let droppedHeadline = "本文は保存していません"
    static let droppedDetail = "パスワードでログインする前に届いたメールです。件名・差出人・本文は保存していません。"
    static let unopenable = "開けませんでした"
    static let noBody = "本文はありません。"

    private func email(_ over: Row) throws -> EmailSummary {
        try JSONCoding.decode(EmailSummary.self, Rows.email(1, over))
    }

    /// A sealed or dropped mail as the database keeps it.
    private func closed(_ state: String, domain: JSONValue = "shop.example.com") throws -> EmailSummary {
        try email([
            "body_state": .string(state), "from_domain": domain,
            "subject": nil, "from_name": nil, "from_address": nil, "text_body": nil, "html_body": nil,
        ])
    }

    @Test func theWords() {
        #expect(MailBody.sealedHeadline == Self.sealedHeadline)
        #expect(MailBody.droppedHeadline == Self.droppedHeadline)
        #expect(MailBody.droppedDetail == Self.droppedDetail)
        #expect(MailBody.unopenable == Self.unopenable)
        #expect(MailBody.noBody == Self.noBody)
    }

    // MARK: the columns

    @Test func decodesBodyStateAndFromDomain() throws {
        let e = try email(["body_state": "sealed", "from_domain": "shop.example.com"])
        #expect(e.bodyState == "sealed")
        #expect(e.fromDomain == "shop.example.com")
    }

    @Test func keepsABodyStateItDoesNotKnow() throws {
        let e = try email(["body_state": "future_state"])
        #expect(e.bodyState == "future_state")
        #expect(MailBodyState(raw: e.bodyState) == .unknown("future_state"))
    }

    @Test func theStates() {
        #expect(MailBodyState(raw: nil) == .plain)
        #expect(MailBodyState(raw: "plain") == .plain)
        #expect(MailBodyState(raw: "sealed") == .sealed)
        #expect(MailBodyState(raw: "dropped") == .dropped)
        #expect(MailBodyState(raw: "Sealed") == .unknown("Sealed"))
        #expect(MailBodyState(raw: "") == .unknown(""))
    }

    @Test func theDetailReadsTheTwoColumnsButNeverTheEnvelope() {
        let columns = ParcelReader.extractionColumns
        guard let open = columns.range(of: "emails("), let close = columns[open.upperBound...].firstIndex(of: ")") else {
            Issue.record("no emails(...) in \(columns)")
            return
        }
        let mail = columns[open.upperBound..<close].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        #expect(mail.contains("body_state"))
        #expect(mail.contains("from_domain"))
        #expect(!columns.contains("body_envelope"))
        // The batch-1 columns stay.
        for c in ["id", "subject", "from_address", "from_name", "sent_at", "classification", "text_body", "html_body"] {
            #expect(mail.contains(c), "\(c)")
        }
    }

    // MARK: the five ways (plain, null, sealed, dropped, unknown)

    @Test func plain() throws {
        let d = MailBody.display(try email(["body_state": "plain", "text_body": "  本文です \n"]))
        #expect(d.kind == .plain)
        #expect(d.subject == "件名1")
        #expect(d.fromText == "テスト店 <shop@example.com>")
        #expect(d.headline == nil)
        #expect(d.fromDomain == nil)
        #expect(d.detail == "本文です")
    }

    @Test func plainWithoutANameShowsTheAddress() throws {
        let d = MailBody.display(try email(["from_name": nil]))
        #expect(d.fromText == "shop@example.com")
        let empty = MailBody.display(try email(["from_name": ""]))
        #expect(empty.fromText == "shop@example.com")
    }

    @Test func plainFallsBackToTheHTML() throws {
        let d = MailBody.display(try email(["text_body": "   ", "html_body": "<p>HTML の本文</p>"]))
        #expect(d.detail == HtmlText.htmlToText("<p>HTML の本文</p>"))
        #expect(d.detail == "HTML の本文")
    }

    @Test func plainWithNoBodySaysSo() throws {
        let d = MailBody.display(try email(["text_body": nil, "html_body": nil]))
        #expect(d.detail == Self.noBody)
        let blank = MailBody.display(try email(["text_body": "", "html_body": ""]))
        #expect(blank.detail == Self.noBody)
    }

    @Test func nullIsPlainAsOnTheWeb() throws {
        let a = MailBody.display(try email(["body_state": nil, "text_body": "本文"]))
        let b = MailBody.display(try email(["body_state": "plain", "text_body": "本文"]))
        #expect(a == b)
        #expect(a.kind == .plain)
    }

    @Test func sealed() throws {
        let d = MailBody.display(try closed("sealed"))
        #expect(d.kind == .sealed)
        #expect(d.headline == Self.sealedHeadline)
        #expect(d.fromDomain == "shop.example.com")
        #expect(d.subject == nil)
        #expect(d.fromText == nil)
        #expect(d.detail == nil)
    }

    @Test func sealedWithoutADomain() throws {
        #expect(MailBody.display(try closed("sealed", domain: nil)).fromDomain == nil)
        #expect(MailBody.display(try closed("sealed", domain: "")).fromDomain == nil)
    }

    @Test func dropped() throws {
        let d = MailBody.display(try closed("dropped"))
        #expect(d.kind == .dropped)
        #expect(d.headline == Self.droppedHeadline)
        #expect(d.fromDomain == "shop.example.com")
        #expect(d.detail == Self.droppedDetail)
        #expect(d.subject == nil)
        #expect(d.fromText == nil)
    }

    @Test func anUnknownStateIsNotOpened() throws {
        // Even with a body there: a state this version does not know is not shown as plain.
        let d = MailBody.display(try email(["body_state": "future_state", "text_body": "読めてしまう本文"]))
        #expect(d.kind == .unopenable)
        #expect(d.headline == Self.unopenable)
        #expect(d.subject == nil)
        #expect(d.fromText == nil)
        #expect(d.detail == nil)
    }

    @Test(arguments: ["sealed", "dropped"])
    func aClosedMailNeverSaysNoBody(state: String) throws {
        let d = MailBody.display(try closed(state))
        for text in [d.subject, d.fromText, d.headline, d.detail, d.fromDomain] {
            #expect(text != Self.noBody)
        }
    }

    // MARK: on the detail screen

    @Test func theTimelineCarriesWhatEachMailShows() throws {
        let plain = Rows.extraction(1, parcel: 1, email: Rows.email(1, ["sent_at": "2026-11-01T00:00:00+00:00"]))
        let sealed = Rows.extraction(2, parcel: 1, email: Rows.email(2, [
            "sent_at": "2026-11-02T00:00:00+00:00", "body_state": "sealed", "from_domain": "shop.example.com",
            "subject": nil, "from_name": nil, "from_address": nil, "text_body": nil, "html_body": nil,
        ]))
        let rows = try [plain, sealed].map { try JSONCoding.decode(ExtractionWithEmail.self, .object($0)) }
        let entries = ParcelDetailModel.timeline(rows, today: "2026-11-04")
        #expect(entries.count == 2)
        #expect(entries.first?.mail?.kind == .plain)
        #expect(entries.last?.mail?.kind == .sealed)
        #expect(entries.last?.mail?.headline == Self.sealedHeadline)
        #expect(entries.last?.mail == MailBody.display(try #require(rows.last?.email)))
    }

    @Test @MainActor func theDetailReadsTheStateFromTheDatabase() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: Rows.email(1, [
            "body_state": "dropped", "from_domain": "shop.example.com",
            "subject": nil, "from_name": nil, "from_address": nil, "text_body": nil, "html_body": nil,
        ]))])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        guard case let .loaded(entries)? = model.timeline else {
            Issue.record("the mail history did not load")
            return
        }
        #expect(entries.first?.mail?.kind == .dropped)
        #expect(entries.first?.mail?.detail == Self.droppedDetail)
        let select = await fake.requests("GET", "extractions").first?.query("select").first ?? ""
        #expect(select.contains("body_state"))
        #expect(select.contains("from_domain"))
        #expect(!select.contains("body_envelope"))
    }
}
