import Foundation
import Testing
@testable import Otodoke

/// Signing out while the stored session cannot be read must still clear the stored session.
@Suite("Sign out with unreadable storage")
@MainActor
struct SignOutUnreadableStorageTests {
    @Test(arguments: stallFailingModes)
    func signingOutClearsTheStoredSessionEvenWhenItCannotBeRead(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        #expect(!w.storage.isEmpty)
        let removesBefore = w.storage.removeCalls
        w.storage.setMode(mode)

        await w.auth.signOut()

        #expect(w.auth.state == .signedOut)
        #expect(w.storage.removeCalls == removesBefore + 1)
        #expect(w.storage.isEmpty)
        // Once reads work again, the old session does not come back.
        w.storage.setMode(.reads)
        #expect(w.auth.provider.auth.currentSession == nil)
    }

    @Test(arguments: stallFailingModes)
    func aFailedClearIsSwallowedAndTheStoredSessionStays(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        let removesBefore = w.storage.removeCalls
        w.storage.setMode(mode)
        w.storage.setRemoveFails(true)

        await w.auth.signOut()

        // The clear is attempted, its failure is ignored, and the app still shows the login screen.
        #expect(w.storage.removeCalls == removesBefore + 1)
        #expect(w.auth.state == .signedOut)
        #expect(RootScreen.of(w.auth.state) == .login)
        w.storage.setMode(.reads)
        #expect(!w.storage.isEmpty)
    }
}
