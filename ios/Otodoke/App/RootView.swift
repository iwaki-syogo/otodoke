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
        if let preview = CategorySavingPreview(arguments: ProcessInfo.processInfo.arguments) {
            preview
        } else if let preview = ListPreview(arguments: ProcessInfo.processInfo.arguments) {
            if preview.showsWelcome {
                WelcomeView(auth: preview.previewAuth())
            } else if let deletion = preview.accountDeletionModel() {
                NavigationStack { AccountDeletionView(model: deletion, email: nil) }
            } else if let screens = preview.consentScreens() {
                MainTabView(screens: screens)
            } else if let login = preview.makeLoginModel() {
                LoginView(model: login)
            } else if let page = preview.deliveredPageModel() {
                NavigationStack { DeliveredView(model: page) { _ in EmptyView() } }
            } else if let page = preview.cancelledPageModel() {
                NavigationStack { CancelledView(model: page) { _ in EmptyView() } }
            } else {
                MainTabView(listModel: preview.makeModel(), detailModel: preview.detailModelMaker())
            }
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
                WelcomeView(auth: auth)
            case .main:
                // N-2: the tabs live as long as one signed-in generation.
                MainTabView(auth: auth)
                    .id(auth.session.value)
            }
        }
        .task { await auth.start() }
        // CX2: in front or not, from launch on (before any sign-in): each generation's key store reads it.
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .background { auth.front.wentToBackground() } else { auth.front.cameToFront() }
        }
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
