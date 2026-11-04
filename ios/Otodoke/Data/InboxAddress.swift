// TDD-STUB(task 7): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of ensureInboxAddress (src/lib/inbox.ts).

import Foundation

enum InboxAddressError: Error, Equatable, Sendable {
    case notSignedIn
    case readFailed
    case insertFailed
    /// Three tries, every one taken.
    case couldNotAllocate
}

struct InboxAddressService: Sendable {
    /// No 0/o/1/l/i.
    static let alphabet: [Character] = []
    static let length = 10

    let provider: SupabaseProvider
    let randomBytes: @Sendable (Int) -> [UInt8]

    init(provider: SupabaseProvider, randomBytes: @escaping @Sendable (Int) -> [UInt8] = InboxAddressService.secureRandomBytes) {
        self.provider = provider
        self.randomBytes = randomBytes
    }

    /// Cryptographically secure bytes.
    static func secureRandomBytes(_ count: Int) -> [UInt8] { [] }

    /// alphabet[byte % alphabet.count] for each byte, as the Web does.
    static func localPart(from bytes: [UInt8]) -> String { "" }

    /// The user's local part: read; if none, insert (3 tries); on 23505 read again.
    func ensure() async throws(InboxAddressError) -> String { throw .readFailed }

    /// "local@domain", or nil when the domain is empty.
    static func email(localPart: String, domain: String) -> String? { nil }
}
