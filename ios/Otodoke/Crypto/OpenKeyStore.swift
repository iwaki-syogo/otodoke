// The two generations and the opened key in memory (task 16, CX2).
//  - SessionGeneration (Codex-001): the signed-in state's number. It moves on at sign-out and whenever the
//    signed-in user changes. Fetching the key, PBKDF2, Face ID and opening a mail note (user_id, generation)
//    when they start; saving to the Keychain and showing on the screen check it first (stale: thrown away).
//  - Sign-out, in this order: ① the generation moves on ② work in flight is cancelled ③ the key and the
//    plaintext in memory go ④ the Keychain item goes (SignOutCleanup, called by AuthService.signOut).
//  - OpenKeyStore (CX2): the opened key lives in memory only while the app is in front. Its own period
//    moves on when the app goes to the background: work in flight is cancelled, the key and every opened
//    mail (PlaintextHolder) are dropped. A put or a shown mail checks both the session and the period.

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
        guard userID != self.userID else { return }
        self.userID = userID
        value += 1
    }

    /// update(userID:) under the name AuthService calls it by (the parcels' one-write-path check counts
    /// every `.update(` call in the app as a write).
    func follow(userID: String?) {
        update(userID: userID)
    }

    /// Sign-out's step ①.
    func advance() {
        value += 1
    }

    func stamp() -> SessionStamp? {
        userID.map { SessionStamp(userID: $0, generation: value) }
    }

    func isCurrent(_ stamp: SessionStamp) -> Bool {
        userID == stamp.userID && value == stamp.generation
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

    /// The key put last, with the session it was put under.
    private var held: (key: OpenedKey, session: SessionStamp)?
    @ObservationIgnored private var work: [Task<Void, Never>] = []

    private struct WeakHolder {
        weak var holder: (any PlaintextHolder)?
    }

    @ObservationIgnored private var holders: [WeakHolder] = []

    init(session: any SessionStamping, vault: KeyVault?) {
        self.session = session
        self.vault = vault
    }

    /// The key in memory, only for the session now.
    var key: OpenedKey? {
        guard let held, session.isCurrent(held.session) else { return nil }
        return held.key
    }

    /// (session, period) now; nil when signed out.
    func stamp() -> UnlockStamp? {
        session.stamp().map { UnlockStamp(session: $0, period: period) }
    }

    /// The session is still the stamp's and the period has not moved.
    func isCurrent(_ stamp: UnlockStamp) -> Bool {
        stamp.period == period && session.isCurrent(stamp.session)
    }

    /// Keeps `key` in memory when `stamp` is current and the key is the stamp's user's; false otherwise.
    @discardableResult
    func put(_ key: OpenedKey, stamp: UnlockStamp) -> Bool {
        guard isCurrent(stamp), key.userID == stamp.session.userID else { return false }
        held = (key, stamp.session)
        return true
    }

    /// Drops only the key in memory (the device key turned out old: a key row with another kid).
    func forgetKey() {
        held = nil
    }

    /// Work cancelled at sign-out and when going to the background.
    func track(_ task: Task<Void, Never>) {
        work.append(task)
    }

    /// Told of each screen that holds opened mail (kept weakly).
    func hold(_ holder: any PlaintextHolder) {
        holders.removeAll { $0.holder == nil }
        guard !holders.contains(where: { $0.holder === holder }) else { return }
        holders.append(WeakHolder(holder: holder))
    }

    /// CX2: the period moves on, work in flight is cancelled, the key and every opened mail are dropped.
    /// The device's Keychain item stays.
    func wentToBackground() {
        cancelWork()
        dropMemory()
    }

    // MARK: SignOutCleanup

    /// The period moves on (so work that finishes late is stale) and every tracked task is cancelled.
    func cancelWork() {
        period += 1
        let tasks = work
        work = []
        for task in tasks { task.cancel() }
    }

    func dropMemory() {
        held = nil
        let live = holders.compactMap(\.holder)
        holders = live.map { WeakHolder(holder: $0) }
        for holder in live { holder.dropPlaintext() }
    }

    func deleteKeychainKey() {
        vault?.remove(.signedOut)
    }
}
