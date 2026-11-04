// TDD-STUB(task 3): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.

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
    static let webBase = URL(string: "about:blank")!

    /// Where the login mail's link lands: https://otodoke.app/auth/confirm?next=%2Fapp
    static let authRedirect = URL(string: "about:blank")!

    /// Reads SUPABASE_URL, SUPABASE_ANON_KEY and INBOUND_DOMAIN (Bundle.main.infoDictionary in the app).
    static func load(info: [String: Any]) throws(AppConfigError) -> AppConfig {
        throw .missing(key: "SUPABASE_URL")
    }
}
