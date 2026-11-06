import SwiftUI

/// The login screen (password-v1): the address and the password, or, to make an account, the address and the
/// password twice. The Turnstile widget sits above the button (every press needs a token). 「パスワードを忘れた」
/// opens the Web's page in Safari (the reset is done on the Web). Every word comes from LoginText (and, for the
/// waiting state after making an account, OnboardingText). While the model waits for the confirmation mail's link
/// the form gives way to the waiting state: coming back to the front, or 「確認しました」, tries the sign-in.
struct LoginView: View {
    @State private var model: LoginModel
    @FocusState private var focused: Bool
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    /// `startMode`: which form opens first (the first screen's two buttons pick one).
    init(auth: AuthService, startMode: LoginModel.Mode = .signIn) {
        let model = LoginModel(auth: auth, turnstile: TurnstileToken())
        if startMode != .signIn { model.setMode(startMode) }
        _model = State(initialValue: model)
    }

    #if DEBUG
    /// DEBUG only: with a model made elsewhere (the screen check), shown with its widget unless `withWidget` is
    /// false (pictures drawn in tests load nothing from Cloudflare).
    init(model: LoginModel, withWidget: Bool = true) {
        if withWidget { model.debugUseTurnstile() }
        _model = State(initialValue: model)
    }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WordmarkView(size: 28)
                    .padding(.bottom, 12)
                if let address = model.confirmationAddress {
                    waitingHeader(address)
                } else {
                    Text(model.mode == .signIn ? LoginText.signInTitle : LoginText.signUpTitle)
                        .font(.largeTitle.bold())
                        .padding(.bottom, 8)
                    emailField
                    switch model.mode {
                    case .signIn:
                        signInFields
                    case .signUp:
                        signUpFields
                    }
                }
                if let turnstile = model.turnstile {
                    TurnstileView(token: turnstile)
                }
                if model.isWaitingForConfirmation {
                    primaryButton(OnboardingText.confirmedButton, enabled: model.canCheckConfirmation) {
                        await model.checkConfirmation(pressed: true)
                    }
                } else {
                    primaryButton(model.mode == .signIn ? LoginText.signInButton : LoginText.signUpButton, enabled: model.canSubmit) {
                        await model.submit()
                    }
                }
                if let notice = model.shownNotice {
                    messageBox(notice, error: false)
                }
                if let message = model.errorMessage {
                    messageBox(message, error: true)
                }
                if model.canResendConfirmation {
                    Button {
                        Task { await model.resendConfirmation() }
                    } label: {
                        Text(model.isWaitingForConfirmation ? OnboardingText.resendButton : LoginText.resendConfirmation).font(.subheadline).underline()
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isWorking)
                }
                if model.isWaitingForConfirmation {
                    startOverLink
                } else {
                    links
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 32)
            .padding(.bottom, 40)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        // The toast 「送り直しました」: goes by itself.
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastBanner(text: toast)
            }
        }
        .animation(.default, value: model.toast)
        // A Turnstile token arrives while waiting (the tap on the widget): the screen goes on at once, without
        // another button. The same rationing as every try by itself.
        .onChange(of: model.turnstile?.hasToken ?? false) { _, has in
            guard has, scenePhase == .active, model.isWaitingForConfirmation else { return }
            Task { await model.tokenArrived() }
        }
        // The screen is left (closed, gone back from): the timer, the wait for a token and the held password stop.
        .onDisappear { model.leaveWait() }
        // Back in front (from the mail's link in Safari): the sign-in is tried once, never in a quick loop.
        .onChange(of: scenePhase) { _, phase in
            model.isInFront = phase == .active
            guard phase == .active, model.isWaitingForConfirmation else { return }
            Task { await model.checkConfirmation() }
        }
    }

    /// The waiting state's top: what to do with the mail, and where it was sent.
    private func waitingHeader(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(OnboardingText.waitingTitle)
                .font(.largeTitle.bold())
                .fixedSize(horizontal: false, vertical: true)
            Text(OnboardingText.waitingLead)
                .font(.body)
                .foregroundStyle(.secondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: address)
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 8)
    }

    private var startOverLink: some View {
        Button {
            model.startOver()
        } label: {
            Text(OnboardingText.startOver).font(.subheadline).underline()
        }
        .buttonStyle(.plain)
        .disabled(model.isWorking)
        .padding(.top, 8)
    }

    private var emailField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(LoginText.emailLabel)
                .font(.subheadline.weight(.medium))
            TextField("you@example.com", text: $model.email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
        }
    }

    private var signInFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(LoginText.passwordLabel)
                .font(.subheadline.weight(.medium))
            SecureField(LoginText.passwordLabel, text: $model.password)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit { submitIfPossible() }
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
        }
    }

    private var signUpFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(LoginText.passwordLabel)
                .font(.subheadline.weight(.medium))
            SecureField(LoginText.passwordLabel, text: $model.password)
                .textContentType(.newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            Text(LoginText.passwordAgainLabel)
                .font(.subheadline.weight(.medium))
                .padding(.top, 4)
            SecureField(LoginText.passwordAgainLabel, text: $model.passwordAgain)
                .textContentType(.newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit { submitIfPossible() }
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            Text(LoginText.passwordRule)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let problem = model.passwordProblem, !model.passwordAgain.isEmpty {
                Text(problem)
                    .font(.caption)
                    .foregroundStyle(OtodokeColor.errorText)
            }
        }
    }

    private var links: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                model.setMode(model.mode == .signIn ? .signUp : .signIn)
            } label: {
                Text(model.mode == .signIn ? LoginText.toSignUp : LoginText.toSignIn).font(.subheadline).underline()
            }
            .buttonStyle(.plain)
            .disabled(model.isWorking)
            if model.mode == .signIn {
                Button {
                    openURL(model.forgotPasswordURL)
                } label: {
                    Text(LoginText.forgotPassword).font(.subheadline).underline()
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 8)
    }

    private func submitIfPossible() {
        guard model.canSubmit else { return }
        focused = false
        Task { await model.submit() }
    }

    /// 「まだ確認できていません…」 is amber as on the Web (border-amber-200 bg-amber-50 text-amber-900).
    private func boxFill(error: Bool, amber: Bool) -> Color {
        if amber { return Palette.amberBackground }
        return (error ? Color.red : Color.green).opacity(0.08)
    }

    @ViewBuilder
    private func messageBox(_ text: String, error: Bool) -> some View {
        let amber = !error && text == OnboardingText.notConfirmedYet
        Text(text)
            .font(.subheadline)
            .foregroundStyle(error ? OtodokeColor.errorText : (amber ? Palette.amberText : Color.primary))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(boxFill(error: error, amber: amber), in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                if amber { RoundedRectangle(cornerRadius: 8).stroke(Palette.amberBorder) }
            }
    }

    private func primaryButton(_ title: String, enabled: Bool, action: @escaping @MainActor () async -> Void) -> some View {
        Button {
            focused = false
            Task { await action() }
        } label: {
            ZStack {
                Text(title).opacity(model.isWorking ? 0 : 1)
                if model.isWorking {
                    ProgressView().tint(Color(.systemBackground))
                }
            }
            .font(.body.weight(.medium))
            .foregroundStyle(Color(.systemBackground))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .background(Color(.label).opacity(enabled || model.isWorking ? 1 : 0.35), in: RoundedRectangle(cornerRadius: OtodokeButton.radius))
        }
        .disabled(!enabled || model.isWorking)
    }
}
