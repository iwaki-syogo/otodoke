// Port of ensureInboxAddress (src/lib/inbox.ts): the user's forwarding address, made on first use.
// Same rules as the Web: 10 characters from a 31-letter alphabet (no 0/o/1/l/i), cryptographically
// secure random bytes, at most 3 tries, and on a unique violation (23505) the user's row is read again.

import Foundation
import PostgREST
import Security

enum InboxAddressError: Error, Equatable, Sendable {
    case notSignedIn
    case readFailed
    case insertFailed
    /// Three tries, every one taken.
    case couldNotAllocate
}

struct InboxAddressService: Sendable {
    /// No 0/o/1/l/i.
    static let alphabet: [Character] = Array("abcdefghjkmnpqrstuvwxyz23456789")
    static let length = 10
    static let tries = 3

    let provider: SupabaseProvider
    let randomBytes: @Sendable (Int) -> [UInt8]

    init(provider: SupabaseProvider, randomBytes: @escaping @Sendable (Int) -> [UInt8] = InboxAddressService.secureRandomBytes) {
        self.provider = provider
        self.randomBytes = randomBytes
    }

    /// Cryptographically secure bytes.
    static func secureRandomBytes(_ count: Int) -> [UInt8] {
        guard count > 0 else { return [] }
        var bytes = [UInt8](repeating: 0, count: count)
        if SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess { return bytes }
        // SystemRandomNumberGenerator is also a CSPRNG on Apple platforms (arc4random).
        var generator = SystemRandomNumberGenerator()
        return (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    }

    /// alphabet[byte % alphabet.count] for each byte, as the Web does.
    static func localPart(from bytes: [UInt8]) -> String {
        String(bytes.map { alphabet[Int($0) % alphabet.count] })
    }

    /// The user's local part: read; if none, insert (3 tries); on 23505 read again.
    func ensure() async throws(InboxAddressError) -> String {
        guard let me = await provider.currentUserID() else { throw .notSignedIn }
        if let existing = try await read(me) { return existing }

        for _ in 0..<Self.tries {
            let bytes = randomBytes(Self.length)
            guard bytes.count == Self.length else { throw .insertFailed }
            let localPart = Self.localPart(from: bytes)
            do {
                try await provider.database.from("inbox_addresses")
                    .insert(InboxAddressRow(userId: me, localPart: localPart), returning: .minimal)
                    .execute()
                return localPart
            } catch let error as PostgrestError where error.code == "23505" {
                // Either this user already has one (a race) or the local part is taken.
                if let existing = try await read(me) { return existing }
                continue
            } catch {
                throw .insertFailed
            }
        }
        throw .couldNotAllocate
    }

    /// "local@domain", or nil when the domain is empty.
    static func email(localPart: String, domain: String) -> String? {
        domain.isEmpty ? nil : "\(localPart)@\(domain)"
    }

    /// The user's local part, nil when there is no row. A failed read throws (never "no row").
    private func read(_ me: String) async throws(InboxAddressError) -> String? {
        do {
            let response = try await provider.database.from("inbox_addresses")
                .select("user_id,local_part")
                .eq("user_id", value: me)
                .execute()
            let rows = try JSONDecoder().decode([InboxAddressRow].self, from: response.data)
            return rows.first?.localPart
        } catch {
            throw .readFailed
        }
    }
}
