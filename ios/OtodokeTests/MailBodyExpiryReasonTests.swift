import Foundation
import Testing
@testable import Otodoke

/// Real JSON decoding and display: an unselected error must not be supplied by a display stub.
@Suite("A24: the stored reason explains only a dropped original mail")
struct MailBodyExpiryReasonTests {
    private static let expiredNotice = "保管の期限を過ぎたため、元のメールは残っていません。"
    private static let neutralNotice = "本文は保存していません"

    enum Reason: String, CaseIterable, Sendable {
        case expired, missing, null, empty, unknown, otherConsent, uppercase, trailingSpace

        var fields: Row {
            switch self {
            case .expired: ["error": "ai_consent_wait_expired"]
            case .missing: [:]
            case .null: ["error": nil]
            case .empty: ["error": ""]
            case .unknown: ["error": "future_drop_reason"]
            case .otherConsent: ["error": "ai_consent_required"]
            case .uppercase: ["error": "AI_CONSENT_WAIT_EXPIRED"]
            case .trailingSpace: ["error": "ai_consent_wait_expired "]
            }
        }
    }

    private func email(state: String?, reason: Reason) throws -> EmailSummary {
        var fields = reason.fields
        fields["body_state"] = state.map(JSONValue.string) ?? .null
        fields["from_domain"] = "shop.example.test"
        fields["text_body"] = "  保存された本文  "
        return try JSONCoding.decode(EmailSummary.self, Rows.email(1, fields))
    }

    private func embeddedColumns(_ select: String) throws -> [String] {
        let start = try #require(select.range(of: "emails("))
        let end = try #require(select[start.upperBound...].firstIndex(of: ")"))
        return select[start.upperBound..<end].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    @Test(arguments: Reason.allCases)
    func onlyTheExactDroppedExpiryGetsTheExpiryNotice(reason: Reason) throws {
        let display = MailBody.display(try email(state: "dropped", reason: reason))
        #expect(display.kind == .dropped)
        #expect(display.headline == Self.neutralNotice)
        #expect(display.detail == (reason == .expired ? Self.expiredNotice : Self.neutralNotice))
        #expect(display.fromDomain == "shop.example.test")
        #expect(display.subject == nil)
        #expect(display.fromText == nil)
        #expect(display.detail?.contains("パスワード") == false)
    }

    @Test(arguments: [nil, "plain", "sealed", "future_state"] as [String?], Reason.allCases)
    func aReasonAloneNeverChangesAnotherBodyState(state: String?, reason: Reason) throws {
        let display = MailBody.display(try email(state: state, reason: reason))
        let withoutReason = MailBody.display(try email(state: state, reason: .missing))
        #expect(display == withoutReason)
        #expect(display.detail != Self.expiredNotice)
        #expect(display.detail != Self.neutralNotice)
        switch state {
        case nil, "plain":
            #expect(display.kind == .plain)
            #expect(display.detail == "保存された本文")
            #expect(display.subject == "件名1")
        case "sealed":
            #expect(display.kind == .sealed)
            #expect(display.detail == nil)
        default:
            #expect(display.kind == .unopenable)
            #expect(display.detail == nil)
        }
    }

    @Test func theEmbeddedSelectActuallyRequestsThePersistedReason() throws {
        let columns = try embeddedColumns(ParcelReader.extractionColumns)
        #expect(columns.filter { $0 == "error" }.count == 1)
        #expect(columns.contains("body_state"))
        #expect(!columns.contains("body_envelope"))
    }

    @Test(arguments: [Reason.expired, .missing])
    @MainActor func theRealReaderCarriesTheReasonIntoTheDetail(reason: Reason) async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        var fields = reason.fields
        fields["body_state"] = "dropped"
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: Rows.email(1, fields))])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        let entries = try #require(model.timeline?.value)
        #expect(entries.count == 1)
        #expect(entries.first?.mail?.detail == (reason == .expired ? Self.expiredNotice : Self.neutralNotice))
        let request = try #require(await fake.requests("GET", "extractions").first)
        let select = try #require(request.query("select").first)
        // FakeSupabase over-fetches rows; capture the real query as well as testing the display.
        #expect(try embeddedColumns(select).contains("error"))
    }

    @Test(arguments: [false, true])
    func anAbsentEmbeddedEmailDoesNotInventARemovalReason(emptyArray: Bool) throws {
        let row = Rows.extraction(1, parcel: 1, email: emptyArray ? .array([]) : .null)
        let extraction = try JSONCoding.decode(ExtractionWithEmail.self, .object(row))
        #expect(extraction.email == nil)
        #expect(ParcelDetailModel.timeline([extraction], today: "2026-11-04").isEmpty)
    }
}
