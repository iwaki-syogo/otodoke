// The first guide, shown once over the tabs right after the login that made the first key (OnboardingGate):
// 「最後に、メールの自動転送を設定しますか？」, then 1. the address with the copy button, 2. the four mail services
// (each folds open to the existing steps), and 「設定しました」 / 「あとで」, both back to the 荷物 tab. The Gmail
// approval card is drawn above step 1 only while a confirmation mail is waiting. Every word is OnboardingText's
// (the owner's wording file); the address and its failures use the same words as 「メールの転送」.

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
    case waiting
    case guide
    case tabs

    static func of(deciding: Bool, outcome: KeySetupOutcome?, guideClosed: Bool) -> Landing {
        if deciding { return .waiting }
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
                SettingsStatusRows(model: model).approvalSection
                VStack(alignment: .leading, spacing: 12) {
                    SettingsParts.heading(OnboardingText.step1Heading)
                    addressPart
                }
                VStack(alignment: .leading, spacing: 12) {
                    SettingsParts.heading(OnboardingText.step2Heading)
                    ForwardingGuideView(servicesOnly: true)
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
            await model.load()
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
                SettingsParts.errorBox(OnboardingText.addressKeyFailed)
            case .none?:
                SettingsParts.secondaryText(OnboardingText.addressNoKey)
            case .present?:
                switch model.address {
                case let .loaded(address)?:
                    HStack(spacing: 8) {
                        Text(address)
                            .font(.subheadline.monospaced())
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if model.addressCanBeCopied {
                            CopyButton(text: address)
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
