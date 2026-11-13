import CryptoKit
import Foundation
@testable import Otodoke

/// [password-login] Shared by the password login suites.
enum PW {
    /// A password the Web's rule accepts (10 code points or more, not weak).
    static let good = "kumo-no-ue-2026"

    /// A fast stand-in for PBKDF2 (SHA-256 of password || 0x00 || salt || the round count as text), so a test
    /// needs no 600,000 rounds. It still depends on the password, the salt (the address) and the round count.
    static let fastKDF: PasswordV1.KDF = { password, salt, iterations in
        Data(SHA256.hash(data: password + Data([0]) + salt + Data(String(iterations).utf8)))
    }

    static func fastDeriver() -> PasswordV1Deriver { PasswordV1Deriver(kdf: fastKDF) }

    /// master the app should make for (address as typed, password as typed) with fastKDF: through the vectors'
    /// own steps (email_norm, NFKC), computed here with PasswordV1's step functions, which the vector suites pin.
    static func master(email: String, password: String) -> Data {
        (try? PasswordV1.master(password: password, email: email, kdf: fastKDF)) ?? Data()
    }

    static func secret(email: String, password: String) -> String {
        PasswordV1.authSecret(master: master(email: email, password: password))
    }

    @MainActor
    static func auth(_ fake: FakeSupabase, deriver: PasswordV1Deriver = PW.fastDeriver(), storage: InMemorySessionStorage = InMemorySessionStorage()) -> AuthService {
        AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage), deriver: deriver, userDefaults: TestDefaults.fresh())
    }

    /// Everything a request carried (URL, headers, body) as text, for "the password is nowhere" checks.
    static func text(_ requests: [StubRequest]) -> String {
        requests.map { r in
            r.url.absoluteString + "\n" + r.headers.map { "\($0.key): \($0.value)" }.joined(separator: "\n") + "\n" + String(decoding: r.body, as: UTF8.self)
        }.joined(separator: "\n----\n")
    }

    /// gotrue_meta_security.captcha_token of a GoTrue request; nil when absent.
    static func captcha(_ request: StubRequest?) -> String? {
        (request?.jsonDictionary?["gotrue_meta_security"] as? [String: Any])?["captcha_token"] as? String
    }

    /// The redirect_to query value, decoded once (as GoTrue reads it).
    static func redirect(_ request: StubRequest?) -> String? {
        request?.query("redirect_to").first
    }

    /// The exact redirect: the Web's confirm page with a query, so GoTrue's `{{ .RedirectTo }}&token_hash=…`
    /// stays one URL.
    static let confirmRedirect = "https://otodoke.app/auth/confirm?next=%2Fapp"
}
