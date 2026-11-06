// TDD-STUB(task 16, CX2): the two generations and the opened key in memory.
//  - SessionGeneration (Codex-001): the signed-in state's number. It moves on at sign-out and whenever the
//    signed-in user changes. Fetching the key, PBKDF2, Face ID and opening a mail note (user_id, generation)
//    when they start; saving to the Keychain and showing on the screen check it first (stale: thrown away).
//  - Sign-out, in this order: ① the generation moves on ② work in flight is cancelled ③ the key and the
//    plaintext in memory go ④ the Keychain item goes (SignOutCleanup, called by AuthService.signOut).
//  - OpenKeyStore (CX2): the opened key lives in memory only while the app is in front. Its own period
//    moves on when the app goes to the background: work in flight is cancelled, the key and every opened
//    mail (PlaintextHolder) are dropped. A put or a shown mail checks both the session and the period.
// Names and signatures are the contract with SessionGenerationTests / UnlockModelTests / SealedMailTests.

import Foundation
import Observation

struct SessionStamp: Equatable, Sendable {
    let userID: String
    let generation: Int
}

@MainActor
protocol SessionStamping: AnyObject {
    /// (user_id, generation) now; nil when signed out.
    func stamp() -> SessionStamp?
    func isCurrent(_ stamp: SessionStamp) -> Bool
}

@MainActor
final class SessionGeneration: SessionStamping {
    private(set) var userID: String?
    private(set) var value = 0

    init() {}

    /// The signed-in user now (nil when signed out): moves on when it is not the one before.
    func update(userID: String?) {
        // TDD-STUB(task 16)
    }

    /// Sign-out's step ①.
    func advance() {
        // TDD-STUB(task 16)
    }

    func stamp() -> SessionStamp? {
        nil // TDD-STUB(task 16)
    }

    func isCurrent(_ stamp: SessionStamp) -> Bool {
        false // TDD-STUB(task 16)
    }
}

/// Sign-out's steps ② ③ ④, in this order, after AuthService moved the generation on (①).
@MainActor
protocol SignOutCleanup: AnyObject {
    func cancelWork()
    func dropMemory()
    func deleteKeychainKey()
}

/// Something that holds opened mail text (the detail screen): told to drop it.
@MainActor
protocol PlaintextHolder: AnyObject {
    func dropPlaintext()
}

/// The session and the front period a piece of work started in.
struct UnlockStamp: Equatable, Sendable {
    let session: SessionStamp
    let period: Int
}

struct OpenedKey: Equatable, Sendable {
    let userID: String
    let recipient: PrivateRecipient

    var keyID: String { recipient.keyID }

    static func == (a: OpenedKey, b: OpenedKey) -> Bool {
        a.userID == b.userID && a.recipient.keyID == b.recipient.keyID && a.recipient.publicKey == b.recipient.publicKey
    }
}

@MainActor
@Observable
final class OpenKeyStore: SignOutCleanup {
    @ObservationIgnored let session: any SessionStamping
    @ObservationIgnored let vault: KeyVault?

    /// Moves on each time the app goes to the background (and at sign-out).
    private(set) var period = 0

    init(session: any SessionStamping, vault: KeyVault?) {
        self.session = session
        self.vault = vault
    }

    /// The key in memory, only for the session now.
    var key: OpenedKey? {
        nil // TDD-STUB(task 16)
    }

    /// (session, period) now; nil when signed out.
    func stamp() -> UnlockStamp? {
        nil // TDD-STUB(task 16)
    }

    /// The session is still the stamp's and the period has not moved.
    func isCurrent(_ stamp: UnlockStamp) -> Bool {
        false // TDD-STUB(task 16)
    }

    /// Keeps `key` in memory when `stamp` is current and the key is the stamp's user's; false otherwise.
    @discardableResult
    func put(_ key: OpenedKey, stamp: UnlockStamp) -> Bool {
        false // TDD-STUB(task 16)
    }

    /// Drops only the key in memory (the device key turned out old: a key row with another kid).
    func forgetKey() {
        // TDD-STUB(task 17)
    }

    /// Work cancelled at sign-out and when going to the background.
    func track(_ task: Task<Void, Never>) {
        // TDD-STUB(task 16)
    }

    /// Told of each screen that holds opened mail (kept weakly).
    func hold(_ holder: any PlaintextHolder) {
        // TDD-STUB(task 16)
    }

    /// CX2: the period moves on, work in flight is cancelled, the key and every opened mail are dropped.
    func wentToBackground() {
        // TDD-STUB(task 16)
    }

    // MARK: SignOutCleanup

    func cancelWork() {
        // TDD-STUB(task 16)
    }

    func dropMemory() {
        // TDD-STUB(task 16)
    }

    func deleteKeychainKey() {
        // TDD-STUB(task 16)
    }
}
