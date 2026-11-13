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
            #if DEBUG
            case .testHost:
                Color.clear
            #endif
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
    #if DEBUG
    /// The host of the unit tests (XCTest injected the test bundle): nothing starts, nothing reads the Keychain or
    /// talks to Supabase. DEBUG only: a Release build has no such case.
    case testHost
    #endif

    static func load(info: [String: Any] = Bundle.main.infoDictionary ?? [:], environment: [String: String] = ProcessInfo.processInfo.environment, arguments: [String] = ProcessInfo.processInfo.arguments) -> AppStart {
        #if DEBUG
        // Unit tests inject their bundle into this app: start nothing (no Keychain, no auth.start(), no Supabase).
        if environment["XCTestConfigurationFilePath"] != nil { return .testHost }
        // The screen check (`-otodoke-ui-preview <scenario>`) shows made-up data and reaches nothing, so it needs no
        // settings: it is let in before the settings are checked. A launch without the argument is checked as before.
        if let preview = ListPreview(arguments: arguments) { return .ready(preview.previewAuth()) }
        #endif
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
            let auth = AuthService(provider: .live(config: config), userDefaults: .standard)
            // B1-1: the main screens (and the opened key's parts) are made once per signed-in generation.
            auth.makeSignedIn = { MainScreens.live(auth: $0) }
            return .ready(auth)
        } catch {
            return .misconfigured(error)
        }
    }
}
