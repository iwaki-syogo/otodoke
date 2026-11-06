// The end of the waiting screen when the sign-in went through but the key did not open or could not be made (the
// Web's sign-up form, notice kind "key"): the waiting screen is gone, no title and no button, only an amber box with
// the key's words and two links: 「このまま進む」 (the 荷物 tab) and 「パスワードとメールの鍵」 (設定's page of that
// name, where the key is made). Nothing is tried by itself after it. The words are LoginText's (the Web's
// LOGIN_MESSAGES: key_not_opened, and the sentence of the failure) and OnboardingText's.
//
// This is not the unlock screen's 「Web でログイン」 help (UnlockModel): that one belongs to a later, ordinary sign-in
// (a key that does not open with the password typed, with the way to the Web's login). The box is only for the
// sign-in that ends the waiting after making an account, as on the Web, where /login has its own handling.

import SwiftUI

enum KeyBox {
    /// The box's words for a key step that ended without a key in memory; nil for any other outcome.
    /// - the key in use does not open with this password: key_not_opened;
    /// - the key could not be read, opened or made: the sentence of that failure as the key step has it.
    static func text(for outcome: KeySetupOutcome?) -> String? {
        switch outcome {
        case .needsWebLogin?: LoginText.keyNotOpened
        case let .failed(message)?: message
        default: nil
        }
    }
}

struct KeyBoxView: View {
    let text: String
    let proceed: () -> Void
    let openKeyPage: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(Palette.amberText)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("key-box-text")
                VStack(spacing: 8) {
                    link(OnboardingText.keyBoxProceed, id: "key-box-proceed", action: proceed)
                    link(OnboardingText.keyBoxKeyPage, id: "key-box-key-page", action: openKeyPage)
                }
            }
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 48)
            .padding(.bottom, 40)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
    }

    private func link(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator)))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}
