import Foundation
import Testing
@testable import Otodoke

/// [Fix S2] A 5xx whose body is not PostgREST's error came from something in front of PostgREST
/// (Cloudflare, a gateway), which may have run the update: the result is unknown, and it is sent once.
/// PostgREST's own errors (its JSON body) stay "not updated".
@Suite("ParcelWriter gateway answers (fix S2)")
@MainActor
struct ParcelWriterGatewayTests {
    nonisolated private static let shownStamp = "2026-11-01T09:30:15.123456+00:00"

    private func writer(_ fake: FakeSupabase) async throws -> ParcelWriter {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelWriter(provider: provider)
    }

    private func shown(_ n: Int) -> ParcelVersion {
        ParcelVersion(id: Rows.id(n), status: "shipped", updatedAt: Self.shownStamp)
    }

    nonisolated static let cloudflare = "<!DOCTYPE html><html><head><title>A timeout occurred</title></head><body>Error code 524</body></html>"

    @Test(arguments: [
        (524, cloudflare, "text/html; charset=UTF-8", true),
        (520, "<html><body>Web server is returning an unknown error</body></html>", "text/html", false),
        (522, "error code: 522", "text/plain", false),
        (503, "<html><body><h1>503 Service Unavailable</h1></body></html>", "text/html", true),
        (500, "upstream failed", "text/plain", false),
        (502, "{\"error\":\"bad gateway\"}", "application/json", true),
        (502, "{\"message\":\"An invalid response was received from the upstream server\"}", "application/json", true),
    ])
    func aGatewayErrorIsUnknownAndSentOnce(status: Int, body: String, contentType: String, applied: Bool) async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .gateway(status, body: body, contentType: contentType, applied: applied))
        #expect(await writer.markDelivered(shown(1)) == .unknown)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await fake.row("parcels", id: Rows.id(1))?["status"]?.string == (applied ? "delivered" : "shipped"))
    }

    @Test func aGatewayErrorOnAnUndoIsUnknown() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        guard case let .success(token) = await writer.markDelivered(shown(1)) else {
            Issue.record("the swipe was not saved")
            return
        }
        await fake.fail("PATCH", "parcels", nth: 2, with: .gateway(524, body: Self.cloudflare, contentType: "text/html", applied: true))
        #expect(await writer.undoDelivered(token) == .unknown)
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test func aGatewayErrorOnACategoryIsUnknown() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .gateway(520, body: "<html></html>", contentType: "text/html", applied: false))
        #expect(await writer.setCategory(id: Rows.id(1), category: .food) == .unknown)
    }

    @Test func aRefusalInFrontOfTheDatabaseIsNotUpdated() async throws {
        // 4xx without PostgREST's body (a WAF's 403, say): refused before the database.
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .gateway(403, body: "<html>Forbidden</html>", contentType: "text/html", applied: false))
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.failed))
    }

    @Test func postgrestsOwn5xxStaysNotUpdated() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .http(503))
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.failed))
    }
}
