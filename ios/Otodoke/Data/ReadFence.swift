// TDD-STUB(task 6) — agreed API, placeholder bodies. Remove this marker once written.
// The fence of ParcelListModel.finishRead as one type (NtH-5): each read gets a ticket; a newer read
// makes an older ticket superseded; a write in flight, or one that started or ended since the ticket
// was taken, makes it stale. M1: the calendar, spend and settings models use it (list and detail: T24).

import Foundation

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

    init() {}

    mutating func beginRead() -> Ticket { Ticket(number: 0, generation: 0) }
    mutating func beginWrite() {}
    mutating func endWrite() {}
    func verdict(_ ticket: Ticket) -> Verdict { .current }
}
