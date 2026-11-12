// The password field (SecureField, no autocorrection or capitalization), its progress and error message,
// and native help: key recovery in a sheet, or signing out to sign in again.
// Every word comes from UnlockModel / FaceIDText / LoginText / PasswordChangeText (no other text
// is added; a vitest checks there is no Japanese literal here). The passphrase lives only in this view's state
// and is cleared after every submit (opened or not) and when the app goes to the background (SEC-N4).

import SwiftUI

struct UnlockView: View {
    @Bindable var model: UnlockModel
    /// Called after the key opened (the caller then opens its mail).
    var onOpened: () -> Void = {}

    @State private var passphrase = ""
    @FocusState private var focused: Bool
    @State private var showsRecovery = false
    @Environment(\.scenePhase) private var scenePhase

    /// Face ID / Touch ID when the key will be kept with it; nil when only memory holds it.
    private var keptWith: BiometryKind? {
        model.policy.isAllowed ? model.biometry : nil
    }

    private var isOpening: Bool { model.phase == .opening }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(FaceIDText.passphraseField(keptWith))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                SecureField(UnlockModel.placeholder, text: $passphrase)
                    .textContentType(.password)
                    .autocorrectionDisabled(true)
                    .textInputAutocapitalization(.never)
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit(submit)
                    .disabled(isOpening)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if isOpening { ProgressView().controlSize(.small).tint(Color(.systemBackground)) }
                        Text(isOpening ? UnlockModel.openingText : UnlockModel.openText)
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(.systemBackground))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color(.label), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(isOpening || passphrase.isEmpty)
                .opacity(isOpening || passphrase.isEmpty ? 0.6 : 1)
            }
            if let message = model.message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(OtodokeColor.errorText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch model.shownHelp {
            case .webLogin?:
                // The key did not open with the login password: offer the native recovery sheet.
                Text(LoginText.keyNotOpened)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if model.recovery != nil {
                    Button { showsRecovery = true } label: { Text(PasswordChangeText.openAnother).font(.subheadline.weight(.medium)) }
                }
            case .signInAgain?:
                Button {
                    Task { await model.signInAgain() }
                } label: {
                    Text(LoginText.signInAgain).font(.subheadline.weight(.medium))
                }
            case nil:
                EmptyView()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // SEC-N4: the password typed does not stay in the field while the app is in the background.
            if phase == .background { passphrase = "" }
        }
        .sheet(isPresented: $showsRecovery) {
            if let recovery = model.recovery { PasswordRecoveryView(model: recovery, onOpened: onOpened) }
        }
    }

    private func submit() {
        guard !isOpening, !passphrase.isEmpty else { return }
        let typed = passphrase
        Task {
            let opened = await model.submit(password: typed)
            // SEC-N4: cleared whether it opened or not (a failure asks for it again).
            passphrase = ""
            if opened { onOpened() }
        }
    }
}
