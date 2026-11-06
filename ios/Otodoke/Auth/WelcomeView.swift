import SwiftUI

/// The first screen, before the login: the wordmark, the Web top page's headline and sentence, and two big
/// buttons of the same size, 「はじめての方」 (makes an account) and 「ログイン」. Each opens LoginView in its
/// mode; back returns here. Every word comes from WelcomeText.
struct WelcomeView: View {
    let auth: AuthService

    private enum Destination: Hashable {
        case signUp
        case signIn
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Spacer(minLength: 24)
                        WordmarkView(size: 40)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(WelcomeText.headlineFirst)
                            Text(WelcomeText.headlineSecond)
                        }
                        .font(.largeTitle.bold())
                        .padding(.top, 40)
                        Text(WelcomeText.lede)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .lineSpacing(4)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 20)
                        Spacer(minLength: 40)
                        VStack(spacing: 12) {
                            NavigationLink(value: Destination.signUp) {
                                WelcomeButtonLabel(title: WelcomeText.newHere, note: WelcomeText.newHereNote, primary: true)
                            }
                            .accessibilityIdentifier("welcome.signUp")
                            NavigationLink(value: Destination.signIn) {
                                WelcomeButtonLabel(title: WelcomeText.signIn, note: nil, primary: false)
                            }
                            .accessibilityIdentifier("welcome.signIn")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 24)
                    .frame(maxWidth: 480, minHeight: geometry.size.height, alignment: .topLeading)
                    .frame(maxWidth: .infinity)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Destination.self) { destination in
                LoginView(auth: auth, startMode: destination == .signUp ? .signUp : .signIn)
            }
        }
    }
}

/// The two buttons' shape (shared with LoginView's main button): the same width and height, the radius of the
/// Web's rounded-xl. The first is black (white in dark mode); the second is a white card with a thin border.
struct WelcomeButtonLabel: View {
    let title: String
    let note: String?
    let primary: Bool
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 64

    var body: some View {
        VStack(spacing: 2) {
            Text(title).font(.body.weight(.semibold))
            if let note {
                Text(note).font(.caption).opacity(0.75)
            }
        }
        .foregroundStyle(primary ? Color(.systemBackground) : Color(.label))
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: minHeight)
        .padding(.horizontal, 12)
        .background(primary ? Color(.label) : Color(.systemBackground), in: RoundedRectangle(cornerRadius: OtodokeButton.radius))
        .overlay {
            if !primary {
                RoundedRectangle(cornerRadius: OtodokeButton.radius).stroke(Color(.separator))
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: OtodokeButton.radius))
    }
}

/// The measures the main buttons share.
enum OtodokeButton {
    /// rounded-xl.
    static let radius: CGFloat = 12
}
