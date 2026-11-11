// The first guide, shown once over the tabs right after the login that made the first key (OnboardingGate):
// 「最後に、メールの自動転送を設定しますか？」, then 1. the address with the copy button, 2. the four mail services
// (each folds open to the existing steps), and 「設定しました」 / 「あとで」, both back to the 荷物 tab. The Gmail
// approval card is drawn above step 1 only while a confirmation mail is waiting. Every word is OnboardingText's
// (the Web's src/lib/onboarding.ts); the address and its failures use the same words as 「メールの転送」.

import SwiftUI

/// When the guide is shown: only after this login made the first key (KeySetupOutcome.created). A login that
/// opened the key already there (opened), a failed key step and the rest show nothing.
enum OnboardingGate {
    static func shouldShow(after outcome: KeySetupOutcome?) -> Bool {
        if case .created? = outcome { return true }
        return false
    }
}

/// What the signed-in screen shows over the tabs. The tabs are built from the start (their lists read meanwhile)
/// but are never seen before the landing is known: after a password sign-in the waiting display stays until the
/// key step has ended, then the guide (the first key was made) or the tabs. Never the tabs first and the guide after.
enum Landing: Equatable {
    case consent
    case waiting
    case guide
    /// The sign-in of the waiting screen went through but the key did not open or could not be made: the amber
    /// box (KeyBox) with 「このまま進む」 and 「パスワードとメールの鍵」, as the Web's waiting screen shows it.
    case keyBox
    case tabs

    /// `fromConfirmation`: the key step was the waiting screen's sign-in. `boxClosed`: the box was left by one of its
    /// two links (it is shown once per signed-in generation, as the guide is).
    static func of(deciding: Bool, outcome: KeySetupOutcome?, guideClosed: Bool, fromConfirmation: Bool = false, boxClosed: Bool = false, gaveUp: Bool = false, needsConsent: Bool = false) -> Landing {
        if needsConsent { return .consent }
        if deciding { return .waiting }
        // The limit let the landing go before the key step ended: the person is in the tabs already, and nothing comes
        // over them later.
        if gaveUp { return .tabs }
        if fromConfirmation, !boxClosed, KeyBox.text(for: outcome) != nil { return .keyBox }
        return !guideClosed && OnboardingGate.shouldShow(after: outcome) ? .guide : .tabs
    }
}

struct OnboardingView: View {
    let model: SettingsModel
    /// 「設定しました」 and 「あとで」: both go to the 荷物 tab.
    let finish: () -> Void
    @State private var hasRead = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(OnboardingText.guideTitle)
                        .font(.title.bold())
                        .fixedSize(horizontal: false, vertical: true)
                    Text(OnboardingText.guideLead)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.mayShowReadingAddress {
                    SettingsStatusRows(model: model, register: {}).approvalSection
                VStack(alignment: .leading, spacing: 12) {
                    SettingsParts.heading(OnboardingText.step1Heading)
                    addressPart
                }
                VStack(alignment: .leading, spacing: 12) {
                    SettingsParts.heading(OnboardingText.step2Heading)
                    ForwardingGuideView(servicesOnly: true)
                }
                } else {
                    AIReadingConsentSettingsControl(model: model)
                }
                VStack(spacing: 12) {
                    SettingsParts.primaryButton(OnboardingText.doneButton, fullWidth: true, action: finish)
                    Button(action: finish) {
                        Text(OnboardingText.laterButton)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator)))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 32)
            .padding(.bottom, 40)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .task {
            await model.loadForwardingGuide()
            hasRead = true
        }
    }

    /// The same cases, words and look as the address on 「メールの転送」 (without its two always-on notes).
    @ViewBuilder
    private var addressPart: some View {
        if !hasRead && model.keyPanel == nil {
            ProgressView().frame(maxWidth: .infinity)
        } else {
            switch model.keyPanel {
            case .failed?, nil:
                SettingsParts.errorBox(SettingsWebText.keyReadFailed)
            case .none?:
                SettingsParts.secondaryText(SettingsWebText.keyNotMade)
            case .present?:
                switch model.address {
                case let .loaded(address)?:
                    HStack(spacing: 8) {
                        Text(address)
                            .accessibilityIdentifier("forwarding-address")
                            .font(model.addressCanBeCopied ? .subheadline.monospaced() : .subheadline)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if model.addressCanBeCopied {
                            CopyButton(text: address)
                                .accessibilityIdentifier("forwarding-copy")
                        }
                    }
                    .padding(12)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
                case .failed?, nil:
                    SettingsParts.errorBox(SettingsModel.failedText)
                }
            }
        }
    }
}
