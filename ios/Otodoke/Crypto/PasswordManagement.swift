import Foundation
import Observation

/// The same compare-and-swap rewrap body as docs/api/keys.md.
struct PasswordRewrap: Encodable, Equatable, Sendable {
    let keyId: String
    let previousWrappedPrivateKey: String
    let wrappedPrivateKey: String
    let wrapIv: String
    let kdfSalt: String
    let kdfIterations: Int

    init(stored: StoredKeyRow, row: NewKeyRow) {
        keyId = stored.keyId
        previousWrappedPrivateKey = stored.wrappedPrivateKey
        wrappedPrivateKey = row.wrappedPrivateKey
        wrapIv = row.wrapIv
        kdfSalt = row.kdfSalt
        kdfIterations = row.kdfIterations
    }
}

struct PasswordChangeInput: Encodable, Sendable {
    let currentAuthSecret: String
    let newAuthSecret: String
    let rewrap: PasswordRewrap?
    let captchaToken: String?

    enum CodingKeys: String, CodingKey { case currentAuthSecret, newAuthSecret, rewrap, captchaToken }

    func encode(to encoder: any Encoder) throws {
        var out = encoder.container(keyedBy: CodingKeys.self)
        try out.encode(currentAuthSecret, forKey: .currentAuthSecret)
        try out.encode(newAuthSecret, forKey: .newAuthSecret)
        if let rewrap { try out.encode(rewrap, forKey: .rewrap) } else { try out.encodeNil(forKey: .rewrap) }
        try out.encodeIfPresent(captchaToken, forKey: .captchaToken)
    }
}

enum PasswordChangeText {
    static let current = "今のパスワード"
    static let next = "新しいパスワード"
    static let again = "新しいパスワードをもう一度"
    static let change = "変える"
    static let changing = "変えています…"
    static let changed = "変えました。前のメールも新しいパスワードで開けます。"
    static let same = "いまと同じパスワードです。別のパスワードを決めてください。"
    static let wrongCurrent = "今のパスワードが違います。"
    static let unknown = "パスワードを変えられたか確かめられませんでした。新しいパスワードでログインし直してください。入れないときは、前のパスワードでログインしてください。"
    static let refused = "パスワードを変えられませんでした。もう一度お試しください。"
    static let refusedKeyNew = "パスワードを変えられませんでした。同じ新しいパスワードで、もう一度お試しください。"
    static let openAnother = "ほかのパスワードで開く"
    static let otherPassword = "ほかのパスワード"
    static let otherWrong = "このパスワードでも、メールの鍵を開けませんでした。"

    static func message(_ code: String) -> String {
        switch code {
        case "credentials", "wrong_current_password": wrongCurrent
        case "same_secret": same
        case "secret_change_unknown": unknown
        case "secret_change_refused": refused
        case "secret_change_refused_key_new": refusedKeyNew
        case "signed_out", "unauthorized": LoginText.signedOut
        case "rate": LoginText.rate
        case "captcha": LoginText.captcha
        case "network", "unavailable": LoginText.network
        default: KeyAPIFailure(rawValue: code)?.message ?? LoginText.other
        }
    }
}

protocol PasswordAccountAPI: Sendable {
    /// Nil is success; otherwise the Web's fixed result code.
    func change(_ input: PasswordChangeInput, accessToken: String) async -> String?
    func rewrap(_ input: PasswordRewrap, accessToken: String) async -> String?
}

struct PasswordAccountClient: PasswordAccountAPI {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.webBase, session: URLSession) { self.baseURL = baseURL; self.session = session }

    func change(_ input: PasswordChangeInput, accessToken: String) async -> String? {
        await post("api/account/password", input, accessToken: accessToken, uncertain: "secret_change_unknown")
    }

    func rewrap(_ input: PasswordRewrap, accessToken: String) async -> String? {
        await post("api/keys/rewrap", input, accessToken: accessToken, uncertain: "network")
    }

    private func post<T: Encodable>(_ path: String, _ input: T, accessToken: String, uncertain: String) async -> String? {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONEncoder().encode(input)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30
        guard request.httpBody != nil else { return "invalid_input" }
        let reply: (Data, URLResponse)
        do { reply = try await session.data(for: request, delegate: KeyAPIClient.NoRedirect()) }
        catch let error as URLError where [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost].contains(error.code) { return "network" }
        catch { return uncertain }
        guard let http = reply.1 as? HTTPURLResponse else { return uncertain }
        guard let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any] else {
            return http.statusCode >= 500 || http.statusCode == 200 ? uncertain : "network"
        }
        if http.statusCode == 200, KeyAPIClient.isJSONTrue(object["ok"]) {
            if path == "api/keys/rewrap", let sent = input as? PasswordRewrap, object["keyId"] as? String != sent.keyId { return "network" }
            return nil
        }
        guard let code = object["code"] as? String else { return uncertain }
        return code
    }
}

/// Build the new wrap from the same private key, then open it before sending anything.
enum PasswordRewrapping {
    static func make(stored: StoredKeyRow, opener: Data, next: Data, userID: String) throws(CryptoError) -> PasswordRewrap {
        try KeyGeneration.rewrap(stored: stored, opener: opener, next: next, userID: userID)
    }
}

@MainActor
@Observable
final class PasswordChangeModel {
    var current = ""
    var next = ""
    var again = ""
    private(set) var isWorking = false
    private(set) var message: String?
    private(set) var succeeded = false
    private(set) var offersSignIn = false
    let turnstile = TurnstileToken()
    @ObservationIgnored private let keys: any MailKeyReading
    @ObservationIgnored private let api: any PasswordAccountAPI
    @ObservationIgnored private let deriver: PasswordV1Deriver
    @ObservationIgnored private let identity: @MainActor () -> (id: String, email: String)?
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let accessToken: @MainActor () async -> String?
    @ObservationIgnored let signOut: @MainActor () async -> Void

    init(keys: any MailKeyReading, api: any PasswordAccountAPI, deriver: PasswordV1Deriver, identity: @escaping @MainActor () -> (id: String, email: String)?, isCurrent: @escaping @MainActor () -> Bool = { true }, accessToken: @escaping @MainActor () async -> String?, signOut: @escaping @MainActor () async -> Void) {
        self.keys = keys; self.api = api; self.deriver = deriver; self.identity = identity; self.isCurrent = isCurrent; self.accessToken = accessToken; self.signOut = signOut
    }

    func clearPasswords() { current = ""; next = ""; again = "" }

    func submit() async {
        guard !isWorking, !current.isEmpty, isCurrent(), let who = identity() else { return }
        succeeded = false; offersSignIn = false
        if let problem = PasswordRule.problem(password: next, again: again) { message = problem; return }
        if PasswordV1.passwordNorm(current) == PasswordV1.passwordNorm(next) { message = PasswordChangeText.same; return }
        isWorking = true; message = nil
        defer { isWorking = false; turnstile.reset() }
        let typedCurrent = current, typedNext = next
        do {
            var oldMaster = try await deriver.master(password: typedCurrent, email: who.email)
            defer { oldMaster.resetBytes(in: 0..<oldMaster.count) }
            var nextMaster = try await deriver.master(password: typedNext, email: who.email)
            defer { nextMaster.resetBytes(in: 0..<nextMaster.count) }
            guard isCurrent(), identity()?.id == who.id else { return }
            let read = await keys.currentKey()
            guard isCurrent(), identity()?.id == who.id else { return }
            guard case let .loaded(stored) = read else { message = LoginText.keyFailed; return }
            var rewrap: PasswordRewrap?
            if let stored {
                // A previous uncertain change may have saved the new wrap already (Web changePassword).
                let opener: Data
                if (try? PasswordV1.openStoredKey(stored, master: oldMaster, userID: who.id)) != nil { opener = oldMaster }
                else if (try? PasswordV1.openStoredKey(stored, master: nextMaster, userID: who.id)) != nil { opener = nextMaster }
                else { message = PasswordChangeText.wrongCurrent; return }
                rewrap = try PasswordRewrapping.make(stored: stored, opener: opener, next: nextMaster, userID: who.id)
            }
            _ = await turnstile.waitUntilSettled(timeout: Turnstile.waitForToken)
            let captchaToken = turnstile.take()
            guard isCurrent(), identity()?.id == who.id, let token = await accessToken(), isCurrent() else { return }
            let code = await api.change(PasswordChangeInput(currentAuthSecret: PasswordV1.authSecret(master: oldMaster), newAuthSecret: PasswordV1.authSecret(master: nextMaster), rewrap: rewrap, captchaToken: captchaToken), accessToken: token)
            guard isCurrent(), identity()?.id == who.id else { return }
            if let code {
                message = PasswordChangeText.message(code)
                offersSignIn = ["secret_change_unknown", "signed_out", "unauthorized", "stale_session"].contains(code)
                if code == "secret_change_unknown" {
                    clearPasswords()
                    await signOut()
                }
            } else {
                clearPasswords(); succeeded = true; offersSignIn = true; message = PasswordChangeText.changed
                await signOut()
            }
        } catch { if isCurrent() { message = LoginText.keyFailed } }
    }
}
