// TDD-STUB(task 4): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of src/lib/match (lastExpectedDay, needsCheck, isLate, faceToFace) and
// src/lib/parcel-sections.ts (sections and byNextArrival, a stable sort).

import Foundation

/// The list's sections. `open` is every parcel neither delivered nor cancelled, in the order given.
struct ParcelSections: Equatable, Sendable {
    var open: [ParcelRow]
    var toCheck: [ParcelRow]
    var delivering: [ParcelRow]
    var soon: [ParcelRow]
    var ordered: [ParcelRow]

    static let empty = ParcelSections(open: [], toCheck: [], delivering: [], soon: [], ordered: [])
}

enum ParcelRules {
    /// CHECK_AFTER_DAYS.
    static let checkAfterDays = 14

    static func lastExpectedDay(_ p: ParcelRow) -> String? { nil }

    static func needsCheck(_ p: ParcelRow, today: String) -> Bool { false }

    static func isLate(_ p: ParcelRow, today: String) -> Bool { false }

    static func faceToFace(_ p: ParcelRow) -> Bool? { nil }

    /// parcelSections(parcels, today), given parcels in the database's order.
    static func sections(_ parcels: [ParcelRow], today: String) -> ParcelSections { .empty }

    /// The database's order of the Web's list: expected_date ascending, nulls last; then last_email_at
    /// descending, nulls last, compared as instants; then id ascending.
    static func baseOrder(_ parcels: [ParcelRow]) -> [ParcelRow] { [] }
}
