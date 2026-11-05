import SwiftUI

@main
struct OtodokeApp: App {
    @State private var start = AppStart.load()

    var body: some Scene {
        WindowGroup {
            switch start {
            case let .ready(auth):
                RootView(auth: auth)
            case let .misconfigured(error):
                ConfigErrorView(error: error)
            }
        }
    }
}

/// The settings from Info.plist, checked before anything talks to Supabase.
@MainActor
enum AppStart {
    case ready(AuthService)
    case misconfigured(AppConfigError)

    static func load(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> AppStart {
        do {
            let config = try AppConfig.load(info: info)
            // Before the auth client reads the Keychain: a session left by an earlier install goes.
            FreshInstall.clearLeftoverSession()
            return .ready(AuthService(provider: .live(config: config)))
        } catch {
            return .misconfigured(error)
        }
    }
}
