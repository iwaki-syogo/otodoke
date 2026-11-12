import SwiftUI

struct PasswordChangeView: View {
    @Bindable var model: PasswordChangeModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsParts.page(spacing: 12) {
            SecureField(PasswordChangeText.current, text: $model.current).textContentType(.password)
            SecureField(PasswordChangeText.next, text: $model.next).textContentType(.newPassword)
            SecureField(PasswordChangeText.again, text: $model.again).textContentType(.newPassword)
            Text(LoginText.passwordRule).font(.caption).foregroundStyle(.secondary)
            TurnstileView(token: model.turnstile)
            Button { Task { await model.submit() } } label: {
                HStack {
                    if model.isWorking { ProgressView() }
                    Text(model.isWorking ? PasswordChangeText.changing : PasswordChangeText.change)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isWorking || model.current.isEmpty || model.next.isEmpty || model.again.isEmpty)
            if let message = model.message {
                Text(message).font(.subheadline).foregroundStyle(model.succeeded ? Color.green : OtodokeColor.errorText)
            }
            if model.offersSignIn { Button(LoginText.signInAgain) { Task { await model.signOut() } } }
        }
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .navigationTitle("パスワードを変える")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: scenePhase) { _, phase in if phase == .background { model.clearPasswords() } }
        .onDisappear { model.clearPasswords() }
    }
}
