import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// [password-v1] PBKDF2 for master runs off the main thread and one at a time (the M2 rule for the passphrase's
/// PBKDF2, kept): PasswordV1Deriver called from the main actor runs the KDF on another thread; calls made
/// while one runs wait for it, so no two run at once, and every caller gets its own answer.
@MainActor
@Suite("password-v1: PBKDF2 off the main thread, one at a time")
struct PasswordV1DeriverTests {
    let v: PasswordV1Vectors

    init() throws {
        v = try PasswordV1Vectors()
    }

    /// A cheap stand-in for PBKDF2 (the round count is checked, not run): SHA-256(password || salt).
    nonisolated static let cheap: PasswordV1.KDF = { (password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data in
        Data(SHA256.hash(data: password + salt + Data(String(iterations).utf8)))
    }

    @Test func theRealPBKDF2RunsOffTheMainThreadAndGivesMaster() async throws {
        let c = try #require(v.named("password_halfwidth_katakana"))
        let rec = PasswordKDFRecorder()
        let deriver = PasswordV1Deriver(kdf: rec.kdf)
        // Called from the main actor (the suite is @MainActor).
        let master = try await deriver.master(password: c.password, email: c.email)
        #expect(master == c.master)
        #expect(rec.calls.count == 1)
        #expect(rec.calls.first?.onMainThread == false)
        #expect(rec.calls.first?.iterations == 600_000)
        #expect(rec.calls.first?.password == c.passwordNormUTF8)
        #expect(rec.calls.first?.salt == c.saltPW)
    }

    @Test func theAppsDefaultDeriverGivesMaster() async throws {
        let c = try #require(v.named("ascii"))
        #expect(try await PasswordV1Deriver().master(password: c.password, email: c.email) == c.master)
    }

    @Test func callsMadeTogetherRunOneAtATimeAndEachGetsItsOwnAnswer() async throws {
        let rec = PasswordKDFRecorder(delay: 0.15, inner: Self.cheap)
        let deriver = PasswordV1Deriver(kdf: rec.kdf)
        async let a = deriver.master(password: "one", email: "a@example.test")
        async let b = deriver.master(password: "two", email: "b@example.test")
        async let c = deriver.master(password: "three", email: "c@example.test")
        let (ma, mb, mc) = try await (a, b, c)
        #expect(rec.calls.count == 3)
        #expect(rec.maxAtOnce == 1)
        #expect(rec.calls.allSatisfy { !$0.onMainThread })
        #expect(rec.calls.allSatisfy { $0.iterations == 600_000 })
        // Each caller its own answer (nothing dropped, nothing mixed up).
        let ea = try Self.cheap(Data("one".utf8), Data("otodoke/pw/v1|a@example.test".utf8), 600_000)
        let eb = try Self.cheap(Data("two".utf8), Data("otodoke/pw/v1|b@example.test".utf8), 600_000)
        let ec = try Self.cheap(Data("three".utf8), Data("otodoke/pw/v1|c@example.test".utf8), 600_000)
        #expect(ma == ea)
        #expect(mb == eb)
        #expect(mc == ec)
        #expect(Set([ma, mb, mc]).count == 3)
    }

    @Test func theMainActorIsFreeWhilePBKDF2Runs() async throws {
        let rec = PasswordKDFRecorder(delay: 0.3, inner: Self.cheap)
        let deriver = PasswordV1Deriver(kdf: rec.kdf)
        let run = Task { try await deriver.master(password: "pw", email: "a@example.test") }
        // The main actor gets to run this while the KDF sleeps on another thread.
        #expect(await waitFor(.seconds(2)) { await MainActor.run { rec.calls.count == 1 } })
        let ticked = await MainActor.run { true }
        #expect(ticked)
        _ = try await run.value
        #expect(rec.calls.count == 1)
        #expect(rec.calls.first?.onMainThread == false)
    }

    @Test func aKDFFailureIsTheCallersError() async {
        let failing: PasswordV1.KDF = { (_: Data, _: Data, _: Int) throws(CryptoError) -> Data in throw .badKeyRow }
        let rec = PasswordKDFRecorder(inner: failing)
        let deriver = PasswordV1Deriver(kdf: rec.kdf)
        do {
            _ = try await deriver.master(password: "pw", email: "a@example.test")
            Issue.record("no error")
        } catch {
            #expect(error == .badKeyRow)
        }
        #expect(rec.calls.count == 1)
    }
}
