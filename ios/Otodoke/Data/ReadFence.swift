// The fence of ParcelListModel.finishRead as one type (NtH-5): each read gets a ticket; a newer read
// makes an older ticket superseded; a write in flight, or one that started or ended since the ticket
// was taken, makes it stale. M1: the calendar, spend and settings models use it (list and detail: T24).

import Foundation
import os

struct ReadFence: Sendable {
    struct Ticket: Equatable, Sendable {
        let number: Int
        let generation: Int
    }

    enum Verdict: Equatable, Sendable {
        /// Show it.
        case current
        /// A newer read was started.
        case superseded
        /// A write was in flight, or started or ended, since the read began.
        case stale
    }

    private(set) var writesInFlight = 0
    /// The number of the newest read.
    private var readNumber = 0
    /// Moves on when a write starts and when it ends.
    private var writeGeneration = 0

    init() {}

    mutating func beginRead() -> Ticket {
        readNumber &+= 1
        return Ticket(number: readNumber, generation: writeGeneration)
    }

    mutating func beginWrite() {
        writesInFlight += 1
        writeGeneration &+= 1
    }

    mutating func endWrite() {
        writesInFlight = max(0, writesInFlight - 1)
        writeGeneration &+= 1
    }

    func verdict(_ ticket: Ticket) -> Verdict {
        guard ticket.number == readNumber else { return .superseded }
        guard ticket.generation == writeGeneration, writesInFlight == 0 else { return .stale }
        return .current
    }
}

/// [CX-f2] Raised the moment the task of a read is cancelled (its .task cancelled when the tab is
/// left), not when the read's awaits end: an appearance meanwhile reads again instead of counting on a
/// read whose answers will be dropped.
final class CutOffSignal: Sendable {
    private let raised = OSAllocatedUnfairLock(initialState: false)

    init() {}

    var isRaised: Bool { raised.withLock { $0 } }

    func raise() { raised.withLock { $0 = true } }
}
