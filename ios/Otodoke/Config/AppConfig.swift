import Foundation

enum AppConfigError: Error, Equatable, Sendable {
    /// The key is absent or empty in Info.plist (e.g. Secrets.xcconfig was not filled in).
    case missing(key: String)
    /// The value is there but unusable (SUPABASE_URL not an https URL with a host).
    case invalid(key: String)
}

struct AppConfig: Equatable, Sendable {
    let supabaseURL: URL
    let anonKey: String
    let inboundDomain: String

    init(supabaseURL: URL, anonKey: String, inboundDomain: String) {
        self.supabaseURL = supabaseURL
        self.anonKey = anonKey
        self.inboundDomain = inboundDomain
    }

    /// The Web: https://otodoke.app
    static let webBase = URL(string: "https://otodoke.app")!

    /// Where the login mail's link lands: https://otodoke.app/auth/confirm?next=%2Fapp
    /// (the Web's confirm page, so the link also works when opened in a browser).
    static let authRedirect = URL(string: "https://otodoke.app/auth/confirm?next=%2Fapp")!

    /// Reads SUPABASE_URL, SUPABASE_ANON_KEY and INBOUND_DOMAIN (Bundle.main.infoDictionary in the app).
    static func load(info: [String: Any]) throws(AppConfigError) -> AppConfig {
        func value(_ key: String) throws(AppConfigError) -> String {
            guard let raw = info[key] as? String else { throw .missing(key: key) }
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw .missing(key: key) }
            return text
        }
        let urlText = try value("SUPABASE_URL")
        let anonKey = try value("SUPABASE_ANON_KEY")
        let inboundDomain = try value("INBOUND_DOMAIN")
        guard let url = URL(string: urlText),
              url.scheme?.lowercased() == "https",
              let host = url.host(), !host.isEmpty
        else { throw .invalid(key: "SUPABASE_URL") }
        return AppConfig(supabaseURL: url, anonKey: anonKey, inboundDomain: inboundDomain)
    }
}
