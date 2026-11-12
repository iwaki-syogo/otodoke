import Foundation

/// The Web's screen-senders.ts values; the Vitest parity check compares every actual entry.
enum RememberedSenderRule {
    struct Entry: Identifiable, Sendable {
        let domain: String
        var id: [UInt16] { Array(domain.utf16) }
    }

    static let sharedMailDomains = [
        "gmail.com", "googlemail.com", "yahoo.co.jp", "ymail.ne.jp", "yahoo.com", "icloud.com",
        "me.com", "mac.com", "outlook.com", "outlook.jp", "hotmail.com", "hotmail.co.jp",
        "live.com", "live.jp", "msn.com", "aol.com", "proton.me", "protonmail.com",
        "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "yahoo.ne.jp",
        "ymobile.ne.jp", "uqmobile.jp", "rakumail.jp", "auone.jp", "mineo.jp", "disney.ne.jp",
        "pdx.ne.jp", "nifty.com", "ybb.ne.jp", "excite.co.jp", "duck.com",
    ]
    static let sharedMailDomainSuffixes = [
        "plala.or.jp", "ocn.ne.jp", "so-net.ne.jp", "biglobe.ne.jp", "auone-net.jp", "dion.ne.jp",
        "odn.ne.jp", "eonet.ne.jp", "hi-ho.ne.jp", "asahi-net.or.jp", "zaq.ne.jp", "home.ne.jp",
    ]

    static func isRememberable(_ domain: String?) -> Bool {
        guard let domain else { return false }
        var value = JSText.trim(domain).lowercased()
        while value.hasSuffix(".") { value.removeLast() }
        guard !value.isEmpty, !sharedMailDomains.contains(value) else { return false }
        return !sharedMailDomainSuffixes.contains { value == $0 || value.hasSuffix(".\($0)") }
    }

    static func domains(_ values: [String?]) -> [String] {
        // Filtering normalizes only for the shared-domain rule. The displayed/write value stays raw.
        var seen = Set<[UInt16]>()
        return values.compactMap { value -> String? in
            guard let value, isRememberable(value), seen.insert(Array(value.utf16)).inserted else { return nil }
            return value
        }.sorted(by: JSText.less)
    }
}
