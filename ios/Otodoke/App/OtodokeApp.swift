import os
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

private let launchLog = Logger(subsystem: "com.iwakisyogo.otodoke", category: "launch")

/// The settings from Info.plist, checked before anything talks to Supabase.
@MainActor
enum AppStart {
    case ready(AuthService)
    case misconfigured(AppConfigError)

    static func load(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> AppStart {
        do {
            let config = try AppConfig.load(info: info)
            // Before the auth client reads the Keychain: a session left by an earlier install goes.
            // When the marker cannot be made, the Keychain is left alone (CF3) and the failure is logged.
            switch FreshInstall.prepare() {
            case .installed, .cleared:
                break
            case .markerFailed:
                launchLog.error("Fresh-install marker could not be written; the Keychain was left as it is")
            case .clearFailed:
                launchLog.error("Leftover Keychain items could not be removed; trying again on the next launch")
            }
            let auth = AuthService(provider: .live(config: config))
            // B1-1: the main screens (and the opened key's parts) are made once per signed-in generation.
            auth.makeSignedIn = { MainScreens.live(auth: $0) }
            return .ready(auth)
        } catch {
            return .misconfigured(error)
        }
    }
}
