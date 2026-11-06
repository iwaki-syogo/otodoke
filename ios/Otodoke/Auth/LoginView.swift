import SwiftUI

/// The login screen (password-v1): the address and the password, or, to make an account, the address and the
/// password twice. The Turnstile widget sits above the button (every press needs a token). 「パスワードを忘れた」
/// opens the Web's page in Safari (the reset is done on the Web). Every word comes from LoginText.
struct LoginView: View {
    @State private var model: LoginModel
    @FocusState private var focused: Bool
    @Environment(\.openURL) private var openURL

    init(auth: AuthService) {
        _model = State(initialValue: LoginModel(auth: auth, turnstile: TurnstileToken()))
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
                Text(model.mode == .signIn ? LoginText.signInTitle : LoginText.signUpTitle)
                    .font(.title.bold())
                emailField
                switch model.mode {
                case .signIn:
                    signInFields
                case .signUp:
                    signUpFields
                }
                if let turnstile = model.turnstile {
                    TurnstileView(token: turnstile)
                }
                primaryButton(model.mode == .signIn ? LoginText.signInButton : LoginText.signUpButton, enabled: model.canSubmit) {
                    await model.submit()
                }
                if let notice = model.notice {
                    messageBox(notice, error: false)
                }
                if let message = model.errorMessage {
                    messageBox(message, error: true)
                }
                if model.canResendConfirmation {
                    Button {
                        Task { await model.resendConfirmation() }
                    } label: {
                        Text(LoginText.resendConfirmation).font(.subheadline)
                    }
                    .disabled(model.isWorking)
                }
                links
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 40)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
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
                Text(model.mode == .signIn ? LoginText.toSignUp : LoginText.toSignIn).font(.subheadline)
            }
            .disabled(model.isWorking)
            if model.mode == .signIn {
                Button {
                    openURL(model.forgotPasswordURL)
                } label: {
                    Text(LoginText.forgotPassword).font(.subheadline)
                }
            }
        }
        .padding(.top, 8)
    }

    private func submitIfPossible() {
        guard model.canSubmit else { return }
        focused = false
        Task { await model.submit() }
    }

    private func messageBox(_ text: String, error: Bool) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(error ? OtodokeColor.errorText : Color.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background((error ? Color.red : Color.green).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
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
            .padding(.vertical, 14)
            .background(Color(.label).opacity(enabled || model.isWorking ? 1 : 0.35), in: RoundedRectangle(cornerRadius: 8))
        }
        .disabled(!enabled || model.isWorking)
    }
}
