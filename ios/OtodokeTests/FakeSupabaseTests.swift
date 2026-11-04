import Foundation
import Testing
@testable import Otodoke

/// Controls for the instrument itself. The writer tests rely on FakeSupabase to tell a write that
/// carries its conditions from one that does not; these show that it does, with raw requests that
/// leave a condition out (the negative controls of the plan's "4 条件の陰性対照").
@Suite("FakeSupabase (instrument)")
struct FakeSupabaseTests {
    private func send(_ fake: FakeSupabase, _ method: String, _ pathAndQuery: String, body: [String: Any]? = nil, token: String?) async throws -> (Int, Any?) {
        var request = URLRequest(url: URL(string: "https://\(fake.host)\(pathAndQuery)")!)
        request.httpMethod = method
        request.setValue(FakeSupabase.anonKey, forHTTPHeaderField: "apikey")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await fake.urlSession.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (status, data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data))
    }

    private func signIn(_ fake: FakeSupabase) async throws -> String {
        var request = URLRequest(url: URL(string: "https://\(fake.host)/auth/v1/verify")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["type": "email", "email": FakeSupabase.email, "token": FakeSupabase.goodCode])
        let (data, _) = try await fake.urlSession.data(for: request)
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try #require(json["access_token"] as? String)
    }

    @Test func refusesRestWithoutTheUsersToken() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let (status, _) = try await send(fake, "GET", "/rest/v1/parcels?select=*", token: nil)
        #expect(status == 401)
    }

    @Test func aPatchWithoutUserIdChangesAnotherUsersRow() async throws {
        let fake = FakeSupabase.make()
        let token = try await signIn(fake)
        await fake.insert("parcels", [Rows.parcel(9, ["user_id": .string(FakeSupabase.other)])])
        let id = Rows.id(9)
        let (_, withCondition) = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(id)&user_id=eq.\(FakeSupabase.me)", body: ["status": "delivered"], token: token)
        #expect((withCondition as? [Any])?.count == 0)
        #expect(await fake.row("parcels", id: id)?["status"] == "shipped")
        let (_, without) = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(id)", body: ["status": "delivered"], token: token)
        #expect((without as? [Any])?.count == 1)
        #expect(await fake.row("parcels", id: id)?["status"] == "delivered")
    }

    @Test func aTimestampSentWithARawPlusDoesNotMatch() async throws {
        let fake = FakeSupabase.make()
        let token = try await signIn(fake)
        await fake.insert("parcels", [Rows.parcel(1)])
        let stamp = "2026-11-01T09:30:15.123456+00:00"
        let encoded = stamp.replacingOccurrences(of: "+", with: "%2B").replacingOccurrences(of: ":", with: "%3A")
        let raw = stamp
        let (_, rawResult) = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(Rows.id(1))&updated_at=eq.\(raw)", body: ["status": "delivered"], token: token)
        #expect((rawResult as? [Any])?.count == 0)
        let (_, encodedResult) = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(Rows.id(1))&updated_at=eq.\(encoded)", body: ["status": "delivered"], token: token)
        #expect((encodedResult as? [Any])?.count == 1)
    }

    @Test func aTimestampThatLostItsMicrosecondsDoesNotMatch() async throws {
        let fake = FakeSupabase.make()
        let token = try await signIn(fake)
        await fake.insert("parcels", [Rows.parcel(1)])
        let truncated = "2026-11-01T09:30:15.123%2B00:00"
        let (_, result) = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(Rows.id(1))&updated_at=eq.\(truncated)", body: ["status": "delivered"], token: token)
        #expect((result as? [Any])?.count == 0)
    }

    @Test func twoFiltersOnOneColumnBothApply() async throws {
        let fake = FakeSupabase.make()
        let token = try await signIn(fake)
        await fake.insert("parcels", [Rows.parcel(1, ["status": "cancelled"])])
        let (_, result) = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(Rows.id(1))&status=neq.cancelled&status=eq.cancelled", body: ["status": "delivered"], token: token)
        #expect((result as? [Any])?.count == 0)
        #expect(await fake.row("parcels", id: Rows.id(1))?["status"] == "cancelled")
    }

    @Test func capsAPageAtAThousandRowsAndCountsAll() async throws {
        let fake = FakeSupabase.make()
        let token = try await signIn(fake)
        await fake.insert("parcels", (1...1200).map { Rows.parcel($0) })
        var request = URLRequest(url: URL(string: "https://\(fake.host)/rest/v1/parcels?select=*&order=id.asc")!)
        request.setValue(FakeSupabase.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("count=exact", forHTTPHeaderField: "Prefer")
        let (data, response) = try await fake.urlSession.data(for: request)
        let rows = try #require(try JSONSerialization.jsonObject(with: data) as? [Any])
        #expect(rows.count == 1000)
        #expect((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Range") == "0-999/1200")
    }

    @Test func aPatchUpdatesUpdatedAtWithMicrosecondsAndAPlus() async throws {
        let fake = FakeSupabase.make()
        let token = try await signIn(fake)
        await fake.insert("parcels", [Rows.parcel(1)])
        let next = await fake.peekNextTimestamp()
        _ = try await send(fake, "PATCH", "/rest/v1/parcels?id=eq.\(Rows.id(1))", body: ["status": "delivered"], token: token)
        let stamp = try #require(await fake.row("parcels", id: Rows.id(1))?["updated_at"]?.string)
        #expect(stamp == next)
        #expect(stamp.contains("+00:00"))
        #expect(stamp.range(of: #"\.\d{6}\+"#, options: .regularExpression) != nil)
    }
}
