// 「古くなった」 across the tabs (CX1): ParcelWriter is the only publisher (on a success or an unknown
// result; once per bulk call). Each screen keeps the version it last read at and reads again the next
// time it is shown when the version has moved.

import Foundation
import Observation

@MainActor
@Observable
final class DataChanges {
    /// Moves on by one at each publish.
    private(set) var version = 0

    init() {}

    /// Called by ParcelWriter only (a vitest checks no other file calls it).
    func publish() {
        version &+= 1
    }
}

/// A screen's mark: the version it last read at.
@MainActor
final class ChangeMark {
    let changes: DataChanges?
    /// The version when the last read started; nil before any read.
    private var readAt: Int?

    init(_ changes: DataChanges?) {
        self.changes = changes
    }

    /// Call when a read starts (the data shown is as new as this version).
    func markRead() {
        readAt = changes?.version
    }

    /// The version moved since `markRead()` (false with no DataChanges, or before any read).
    var isStale: Bool {
        guard let changes, let readAt else { return false }
        return changes.version != readAt
    }
}
