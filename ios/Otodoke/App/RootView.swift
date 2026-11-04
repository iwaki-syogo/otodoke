// RootView shows the screen RootScreen.of(...) picks for the sign-in state.

import SwiftUI

enum RootScreen: Equatable, Sendable {
    case loading
    case login
    case main

    static func of(_ state: AuthService.State) -> RootScreen {
        switch state {
        case .unknown: .loading
        case .signedOut: .login
        case .signedIn: .main
        }
    }
}

struct RootView: View {
    let auth: AuthService
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        #if DEBUG
        if let preview = ListPreview(arguments: ProcessInfo.processInfo.arguments) {
            MainTabView(listModel: preview.makeModel())
        } else {
            signedInOrOut
        }
        #else
        signedInOrOut
        #endif
    }

    private var signedInOrOut: some View {
        Group {
            switch RootScreen.of(auth.state) {
            case .loading:
                ProgressView()
            case .login:
                LoginView(auth: auth)
            case .main:
                MainTabView(reader: ParcelReader(provider: auth.provider), writer: ParcelWriter(provider: auth.provider))
            }
        }
        .task { await auth.start() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, auth.state != .unknown else { return }
            Task { await auth.checkSession() }
        }
    }
}

/// Shown instead of the app when Info.plist lacks a setting (Secrets.xcconfig not filled in).
struct ConfigErrorView: View {
    let error: AppConfigError

    var body: some View {
        VStack(spacing: 8) {
            Text("設定を読み込めませんでした")
                .font(.headline)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }

    private var detail: String {
        switch error {
        case let .missing(key), let .invalid(key): key
        }
    }
}
