import Foundation
import Testing
@testable import Otodoke

/// Receipt expectations are produced by the Web functions themselves, in the same file as the
/// other parity cases. Separate assertions keep a regenerated snapshot from dropping the feature.
@Suite("Web parity: received parcels")
struct WebParityReceivedTests {
    private struct Fixture: Decodable {
        let received: Receipt
        struct Receipt: Decodable {
            struct At: Decodable { let value: String?; let out: Bool }
            struct New: Decodable { let input: [String: String]; let now: String; let out: Row }
            struct Edit: Decodable {
                let input: [String: String]
                let saved: ManualParcel.Saved
                let now: String
                let out: Row
            }
            let at: [At]
            let newManual: [New]
            let editManual: [Edit]
        }
    }

    private func fixture() throws -> Fixture {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/web-expected.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: WebExpected.bundledURL() ?? source))
    }

    private func input(_ fields: [String: String]) -> ManualParcelInput {
        var input = ManualParcelInput()
        input.title = fields["title"] ?? ""
        input.shop = fields["shop"] ?? ""
        input.orderedAt = fields["ordered_at"] ?? ""
        input.expectedDate = fields["expected_date"] ?? ""
        input.totalAmount = fields["total_amount"] ?? ""
        input.category = fields["category"] ?? ""
        input.trackingNumber = fields["tracking_number"] ?? ""
        input.carrier = fields["carrier"] ?? "auto"
        input.presence = fields["presence"] ?? ""
        input.status = fields["status"] ?? "ordered"
        return input
    }

    @Test func finiteReceiptTimesMatchTheWeb() throws {
        let cases = try fixture().received.at
        #expect(cases.contains { $0.value == "-infinity" && !$0.out })
        #expect(cases.contains { $0.out })
        for c in cases { #expect(ParcelRules.isReceivedAt(c.value) == c.out, "value=\(c.value.debugDescription)") }
    }

    @Test func allFourManualChoicesWriteTheWebsValuesInOneRow() throws {
        let cases = try fixture().received.newManual
        #expect(Set(cases.compactMap { $0.input["status"] }) == Set(ManualStatus.allCases.map(\.rawValue)))
        for c in cases {
            let now = try #require(ISO.date(c.now))
            guard case let .valid(row) = ManualParcel.check(input(c.input), userId: "test-user", now: now) else {
                Issue.record("valid Web input rejected")
                continue
            }
            var got = try JSONDecoder().decode(Row.self, from: JSONEncoder().encode(row))
            got.removeValue(forKey: "user_id")
            #expect(got == c.out, "choice=\(c.input["status"] ?? "")")
        }
    }

    @Test func manualReceiptTransitionsAndFourteenDayAnswersMatchTheWeb() throws {
        let cases = try fixture().received.editManual
        #expect(cases.contains { $0.out["check_dismissed_at"] != nil })
        #expect(cases.contains { $0.out["received_at"] == .null && $0.out["check_dismissed_at"] == nil })
        for c in cases {
            let now = try #require(ISO.date(c.now))
            guard case let .valid(columns) = ManualParcel.checkEdit(input(c.input), saved: c.saved, now: now) else {
                Issue.record("valid Web edit rejected")
                continue
            }
            let got = try JSONDecoder().decode(Row.self, from: JSONEncoder().encode(columns))
            for key in ["status", "received_at", "check_dismissed_at"] {
                #expect(got[key] == c.out[key], "choice=\(c.input["status"] ?? "") key=\(key)")
            }
        }
    }

    @Test func sectionsCannotLoseTheDeliveredUnreceivedAndAnsweredCases() throws {
        let cases = try WebExpected.load().sections
        let parcels = cases.flatMap(\.parcels)
        #expect(parcels.contains { $0.status == "delivered" && $0.receivedAt == nil })
        #expect(parcels.contains { ParcelRules.isReceived($0) })
        #expect(parcels.contains { $0.checkDismissedAt != nil })
        #expect(cases.contains { !$0.out.arrived.isEmpty })
        #expect(cases.contains { c in c.parcels.contains { $0.status == "delivered" && c.out.toCheck.contains($0.id) } })
        for c in cases {
            let sections = ParcelRules.sections(c.parcels, today: c.today)
            #expect(sections.arrived.map(\.id) == c.out.arrived)
            #expect(sections.toCheck.map(\.id) == c.out.toCheck)
            let ids = (sections.arrived + sections.toCheck + sections.delivering + sections.soon + sections.ordered).map(\.id)
            #expect(Set(ids).count == ids.count)
            #expect(!parcels.filter(ParcelRules.isReceived).contains { ids.contains($0.id) })
        }
    }
}
