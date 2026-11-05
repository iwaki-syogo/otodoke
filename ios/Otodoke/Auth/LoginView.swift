import SwiftUI

/// The login screen: e-mail address → the 8-digit code from the mail.
struct LoginView: View {
    @State private var model: LoginModel
    @FocusState private var focused: Bool

    init(auth: AuthService) {
        _model = State(initialValue: LoginModel(auth: auth))
    }

    #if DEBUG
    /// DEBUG only: with a model made elsewhere (the screen check).
    init(model: LoginModel) {
        _model = State(initialValue: model)
    }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("ログイン")
                    .font(.title.bold())
                switch model.step {
                case .email:
                    emailStep
                case let .code(address):
                    codeStep(address)
                }
                if let message = model.errorMessage {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 40)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("メールアドレス")
                .font(.subheadline.weight(.medium))
            TextField("you@example.com", text: $model.email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .focused($focused)
                .onSubmit { Task { await model.sendCode() } }
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            primaryButton("コードを送る", enabled: !model.email.trimmingCharacters(in: .whitespaces).isEmpty) {
                await model.sendCode()
            }
        }
    }

    private func codeStep(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(address) にコードを送りました。")
                .font(.subheadline)
            Text("\(LoginModel.codeLength) 桁のコード")
                .font(.subheadline.weight(.medium))
            TextField("12345678", text: $model.code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .font(.title3.monospacedDigit())
                .focused($focused)
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                .onChange(of: model.code) { _, typed in
                    let digits = String(typed.filter { $0.isASCII && $0.isNumber }.prefix(LoginModel.codeLength))
                    if digits != typed { model.code = digits }
                }
            primaryButton("ログイン", enabled: model.canVerify) {
                await model.verify()
            }
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                let wait = model.resendWaitSeconds()
                Button {
                    Task { await model.resend() }
                } label: {
                    Text(wait > 0 ? "コードをもう一度送る（\(wait) 秒後）" : "コードをもう一度送る")
                        .font(.subheadline)
                }
                .disabled(wait > 0 || model.isWorking)
            }
            Button("メールアドレスを変える") { model.changeAddress() }
                .font(.subheadline)
                .disabled(model.isWorking)
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
            .padding(.vertical, 14)
            .background(Color(.label).opacity(enabled ? 1 : 0.35), in: RoundedRectangle(cornerRadius: 8))
        }
        .disabled(!enabled || model.isWorking)
    }
}
