import Foundation
@testable import Otodoke

/// Made-up rows in the database's shape (every column of public.parcels). Nothing here is real data.
enum Rows {
    /// A valid lowercase UUID whose text order follows n.
    static func id(_ n: Int) -> String { "00000000-0000-4000-8000-" + String(format: "%012d", n) }

    static func parcel(_ n: Int, _ over: Row = [:]) -> Row {
        var row: Row = [
            "id": .string(id(n)),
            "user_id": .string(FakeSupabase.me),
            "shop": "テスト店",
            "shop_key": nil,
            "title": .string("品名\(n)"),
            "status": "shipped",
            "source": "mail",
            "category": nil,
            "category_source": nil,
            "carrier": nil,
            "tracking_number": nil,
            "tracking_url": nil,
            "order_number": nil,
            "ordered_at": nil,
            "expected_date": nil,
            "expected_date_end": nil,
            "expected_text": nil,
            "expected_window_start": nil,
            "expected_window_end": nil,
            "last_email_at": nil,
            "needs_review": false,
            "requires_presence": nil,
            "presence_evidence": nil,
            "total_amount": nil,
            "created_at": "2026-11-01T00:00:00+00:00",
            "updated_at": "2026-11-01T09:30:15.123456+00:00",
        ]
        for (k, v) in over { row[k] = v }
        return row
    }

    static func parcelRow(_ row: Row) throws -> ParcelRow {
        try JSONCoding.decode(ParcelRow.self, .object(row))
    }

    static func item(_ n: Int, parcel: Int, _ over: Row = [:]) -> Row {
        var row: Row = [
            "id": .string(id(10_000 + n)),
            "parcel_id": .string(id(parcel)),
            "user_id": .string(FakeSupabase.me),
            "name": .string("品目\(n)"),
            "quantity": 1,
            "unit_price": 1200,
            "evidence": nil,
            "created_at": "2026-11-01T00:00:00+00:00",
        ]
        for (k, v) in over { row[k] = v }
        return row
    }

    /// An extraction row with its mail already embedded (as `emails(...)` comes back).
    static func extraction(_ n: Int, parcel: Int, email: JSONValue, _ over: Row = [:]) -> Row {
        var row: Row = [
            "id": .string(id(20_000 + n)),
            "parcel_id": .string(id(parcel)),
            "user_id": .string(FakeSupabase.me),
            "email_id": .string(id(30_000 + n)),
            "model": "test-model",
            "confidence": 0.9,
            "result": ["notes": nil],
            "created_at": "2026-11-01T00:00:00+00:00",
            "emails": email,
        ]
        for (k, v) in over { row[k] = v }
        return row
    }

    static func email(_ n: Int, _ over: Row = [:]) -> JSONValue {
        var row: Row = [
            "id": .string(id(30_000 + n)),
            "subject": .string("件名\(n)"),
            "from_address": "shop@example.com",
            "from_name": "テスト店",
            "sent_at": "2026-11-01T00:00:00+00:00",
            "classification": "shipped",
            "text_body": "本文",
            "html_body": nil,
        ]
        for (k, v) in over { row[k] = v }
        return .object(row)
    }
}

enum ISO {
    /// Parses "2026-11-04T05:00:00Z" / "...00.123Z" / "...+09:00" (test side only).
    static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: text) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}

/// Polls until `condition` holds or the time is up.
func waitFor(_ timeout: Duration = .seconds(5), _ condition: @escaping @Sendable () async -> Bool) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

/// A clock the test moves by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date) { current = start }

    var now: Date { lock.withLock { current } }

    func advance(seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }

    var function: @Sendable () -> Date { { [self] in self.now } }
}

/// A sleep the test fires by hand. Cancelling the sleeping task ends its sleep with
/// CancellationError, as Task.sleep does, so an implementation that cancels an old timer behaves
/// the same here as in the app.
final class ControlledSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var nextID = 0
    private var pending: [(id: Int, continuation: CheckedContinuation<Void, Error>)] = []
    private var cancelledEarly: Set<Int> = []
    private var requestedDurations: [Duration] = []

    var requested: [Duration] { lock.withLock { requestedDurations } }
    var pendingCount: Int { lock.withLock { pending.count } }

    var sleep: @Sendable (Duration) async throws -> Void {
        { [self] duration in try await self.wait(duration) }
    }

    func wait(_ duration: Duration) async throws {
        let id: Int = lock.withLock {
            nextID += 1
            requestedDurations.append(duration)
            return nextID
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                let early: Bool = lock.withLock {
                    if cancelledEarly.contains(id) { return true }
                    pending.append((id, c))
                    return false
                }
                if early { c.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let c: CheckedContinuation<Void, Error>? = lock.withLock {
                if let i = pending.firstIndex(where: { $0.id == id }) {
                    return pending.remove(at: i).continuation
                }
                cancelledEarly.insert(id)
                return nil
            }
            c?.resume(throwing: CancellationError())
        }
    }

    /// Ends the oldest sleep still running. False when none is.
    @discardableResult
    func fireOldest() -> Bool {
        let c: CheckedContinuation<Void, Error>? = lock.withLock { pending.isEmpty ? nil : pending.removeFirst().continuation }
        c?.resume()
        return c != nil
    }

    func fireAll() {
        while fireOldest() {}
    }
}

/// A deterministic generator for shuffles.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Runs `body` with the process's default time zone set to `identifier`. The ported logic must not
/// care: it names Asia/Tokyo itself. (The scheme also runs the suite with TZ=UTC.)
func withDefaultTimeZone<T>(_ identifier: String, _ body: () throws -> T) rethrows -> T {
    let saved = NSTimeZone.default
    NSTimeZone.default = TimeZone(identifier: identifier)!
    defer { NSTimeZone.default = saved }
    return try body()
}

/// Time zones the parity suites run under: JST itself, UTC, behind UTC, and +14.
let parityTimeZones = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"]
