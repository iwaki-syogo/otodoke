import Foundation
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import Otodoke

/// [Fix SEC-S1・SEC-N1・SEC-N4] A session left in the Keychain by an earlier install is removed on the
/// first launch; the in-app web view is titled by the page shown now; a copied tracking number stays
/// on this device and expires.
@Suite("Security fixes (fix 1)", .serialized)
@MainActor
struct SecurityFixTests {
    private func scratch() -> (marker: URL, keychain: KeychainSessionStorage) {
        let dir = FileManager.default.temporaryDirectory.appending(path: "otodoke-fresh-\(UUID().uuidString)", directoryHint: .isDirectory)
        return (dir.appending(path: "Application Support/installed"), KeychainSessionStorage(service: "test.otodoke.fresh.\(UUID().uuidString)"))
    }

    // MARK: SEC-S1

    @Test func aFirstLaunchRemovesASessionLeftByAnEarlierInstall() throws {
        let (marker, keychain) = scratch()
        let other = KeychainSessionStorage(service: "test.otodoke.other.\(UUID().uuidString)")
        defer {
            keychain.removeAll()
            other.removeAll()
            try? FileManager.default.removeItem(at: marker.deletingLastPathComponent().deletingLastPathComponent())
        }
        try keychain.store(key: "sb-test-auth-token", value: Data("left".utf8))
        try keychain.store(key: "another-key", value: Data("left too".utf8))
        try other.store(key: "sb-test-auth-token", value: Data("not ours".utf8))

        #expect(FreshInstall.clearLeftoverSession(marker: marker, keychain: keychain) == true)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == nil)
        #expect(try keychain.retrieve(key: "another-key") == nil)
        #expect(FileManager.default.fileExists(atPath: marker.path(percentEncoded: false)))
        // Another service's item is left alone.
        #expect(try other.retrieve(key: "sb-test-auth-token") == Data("not ours".utf8))
    }

    @Test func laterLaunchesKeepTheSession() throws {
        let (marker, keychain) = scratch()
        defer {
            keychain.removeAll()
            try? FileManager.default.removeItem(at: marker.deletingLastPathComponent().deletingLastPathComponent())
        }
        #expect(FreshInstall.clearLeftoverSession(marker: marker, keychain: keychain) == true)
        try keychain.store(key: "sb-test-auth-token", value: Data("signed in".utf8))
        #expect(FreshInstall.clearLeftoverSession(marker: marker, keychain: keychain) == false)
        #expect(try keychain.retrieve(key: "sb-test-auth-token") == Data("signed in".utf8))
    }

    @Test func aLeftoverSessionNeverReachesTheAuthClient() async throws {
        // The app's order: clear, then make the client that reads the Keychain.
        let fake = FakeSupabase.make()
        let (marker, keychain) = scratch()
        defer {
            keychain.removeAll()
            try? FileManager.default.removeItem(at: marker.deletingLastPathComponent().deletingLastPathComponent())
        }
        let first = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: keychain)
        // password-v1: signed in with the password (the code login is gone).
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        try await AuthService(provider: first, deriver: PW.fastDeriver()).signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        #expect(try keychain.retrieve(key: SupabaseProvider.storageKey(for: fake.config)) != nil)

        // Without the clearing, a new client would open signed in (the control).
        let reinstalled = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: keychain)
        #expect(reinstalled.auth.currentSession != nil)

        // The app is deleted and installed again: the marker is gone, the Keychain item is not.
        FreshInstall.clearLeftoverSession(marker: marker, keychain: keychain)
        let again = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: keychain)
        #expect(again.auth.currentSession == nil)
        #expect(await again.currentUserID() == nil)
    }

    @Test func theAppClearsTheAuthServiceItsClientUses() {
        #expect(KeychainSessionStorage().service == "com.iwakisyogo.otodoke.auth")
        #expect(FreshInstall.marker.lastPathComponent == "installed")
        #expect(FreshInstall.marker.deletingLastPathComponent() == URL.applicationSupportDirectory)
    }

    // MARK: SEC-N1

    @Test func theWebViewIsTitledByThePageShownNow() {
        #expect(TrackingPage.title(for: URL(string: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko")) == "toi.kuronekoyamato.co.jp")
        #expect(TrackingPage.title(for: URL(string: "https://example.org/login")) == "example.org")
        #expect(TrackingPage.title(for: nil) == "")
    }

    // MARK: SEC-N4

    @Test func aCopiedNumberStaysOnThisDeviceAndExpires() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let options = TrackingPage.copyOptions(now: now)
        #expect(options[.localOnly] as? Bool == true)
        #expect(options[.expirationDate] as? Date == now.addingTimeInterval(300))
        #expect(TrackingPage.copyLifetime == 300)

        let board = try #require(UIPasteboard(name: UIPasteboard.Name("test.otodoke.\(UUID().uuidString)"), create: true))
        defer { UIPasteboard.remove(withName: board.name) }
        TrackingPage.copy("123456789012", to: board, now: Date())
        #expect(board.string == "123456789012")
    }
}
