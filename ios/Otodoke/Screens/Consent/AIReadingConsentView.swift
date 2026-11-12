import SafariServices
import SwiftUI

enum AIReadingConsentText {
    static let title = "メールの読み取り"
    static let body = "届いたメールは、Anthropic の Claude で読み取ります。"
    static let explanation = "メールの件名・差出人・本文を送り、荷物の情報を取り出します。"
    static let privacy = "プライバシーポリシー"
    static let allow = "許可する"
    static let deny = "許可しない"
    static let stop = "読み取りをやめる"
    static let start = "読み取りを許可する"
    static let retry = "もう一度読み込む"
    static let readFailed = "読み取りの許可を確認できませんでした。もう一度読み込んでください。"
    static let saveFailed = "読み取りの許可を保存できませんでした。もう一度お試しください。"
    static let sample = "サンプルで試す"
    static let manual = "手で登録する"
    static let retainedResults = "すでに読み取った荷物と結果は残ります。設定の「サンプルで試す」にある「すべての荷物を消す」で消せます。"
    static let waitingRetention = "許可を待つメールは、届いてから 14 日で消えます。"
}

/// A blocking choice above the app. Manual parcels and samples remain available after declining.
struct AIReadingConsentView: View {
    let model: AIReadingConsentModel
    let saveChoice: @MainActor (Bool) async -> Bool
    var onChanged: @MainActor () async -> Void = {}
    #if DEBUG
    var debugConsentSettings: SettingsModel? = nil
    #endif
    @State private var showsPrivacy = false
    @AccessibilityFocusState private var titleIsFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.consentModalIsPresented) private var presentationReady

    var body: some View {
        AIReadingConsentModal {
            VStack(spacing: 16) {
                // Unknown is not unselected: an answered account must never flash a question while loading.
                if model.decision == nil, model.message == nil {
                    ProgressView()
                        .accessibilityLabel(SettingsMenuText.loadingLabel)
                        .padding(12)
                } else {
                    Text(AIReadingConsentText.title)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($titleIsFocused)
                        .accessibilityIdentifier("ai-reading-consent.title")
                    if model.decision != nil {
                        Text(AIReadingConsentText.body)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("ai-reading-consent.body")
                        Text(AIReadingConsentText.explanation)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("ai-reading-consent.explanation")
                        Button { showsPrivacy = true } label: {
                            Text(AIReadingConsentText.privacy)
                                .foregroundStyle(Color.primary)
                                .underline()
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                            .accessibilityIdentifier("ai-reading-consent.privacy")
                    }
                    if model.isLoading || model.isSaving { ProgressView() }
                    if let message = model.message {
                        SettingsParts.errorBox(message)
                            .accessibilityIdentifier("ai-reading-consent.error")
                        Button { Task { await model.load() } } label: {
                            Text(AIReadingConsentText.retry)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                            .accessibilityIdentifier("ai-reading-consent.retry")
                            .disabled(model.isLoading || model.isSaving)
                    }
                    if model.decision != nil {
                        choices
                            .disabled(model.isSaving || model.isLoading)
                    }
                }
            }
            .multilineTextAlignment(.center)
            #if DEBUG
            .overlay {
                if let debugConsentSettings { ConsentPreviewModalCounters(settings: debugConsentSettings) }
            }
            #endif
        }
        // The window's links and choices use the adaptive label color, including their bordered fills.
        .tint(Color.primary)
        .sheet(isPresented: $showsPrivacy, onDismiss: { titleIsFocused = true }) { AIReadingPrivacySheet() }
        .onChange(of: presentationReady, initial: true) { _, ready in
            titleIsFocused = ready && (model.decision != nil || model.message != nil)
        }
        .onChange(of: model.decision) { _, decision in
            if presentationReady, decision != nil { titleIsFocused = true }
        }
        .onChange(of: model.message) { _, message in
            if presentationReady, message != nil { titleIsFocused = true }
        }
    }

    @ViewBuilder private var choices: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: 8) { choiceButtons }
        } else {
            HStack(spacing: 8) { choiceButtons }
        }
    }

    @ViewBuilder private var choiceButtons: some View {
        choice(AIReadingConsentText.deny, allowed: false, id: "ai-reading-consent.deny")
        choice(AIReadingConsentText.allow, allowed: true, id: "ai-reading-consent.allow")
    }

    private func choice(_ title: String, allowed: Bool, id: String) -> some View {
        Button {
            Task { if await saveChoice(allowed) { await onChanged() } }
        } label: {
            Text(title)
                .font(.body.weight(allowed ? .semibold : .regular))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier(id)
    }
}

struct AIReadingConsentSettingsControl: View {
    let model: SettingsModel
    @State private var showsPrivacy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsParts.heading(AIReadingConsentText.title)
            Text(AIReadingConsentText.body).font(.subheadline)
            Button(AIReadingConsentText.privacy) { showsPrivacy = true }
                .font(.subheadline)
            if let message = model.readingConsent.message { SettingsParts.errorBox(message) }
            Button(model.readingConsent.decision == .allowed ? AIReadingConsentText.stop : AIReadingConsentText.start) {
                if model.readingConsent.decision == .allowed {
                    Task { _ = await model.chooseReadingConsent(false) }
                } else {
                    model.requestReadingConsent()
                }
            }
            .disabled(model.readingConsent.isLoading || model.readingConsent.isSaving)
            .accessibilityIdentifier("settings.ai-reading")
            if model.readingConsent.isLoading || model.readingConsent.isSaving { ProgressView() }
        }
        .sheet(isPresented: $showsPrivacy) { AIReadingPrivacySheet() }
    }
}

/// Kept with the signed-in models, so automatic reading outlives the saving sheet.
struct AIReadingAutomaticStatusView: View {
    let model: MailActionsModel

    var body: some View {
        if model.isAutomaticallyReading {
            HStack(spacing: 10) {
                ProgressView()
                Text(SettingsMailText.readBusy).font(.subheadline)
            }
            .frame(maxWidth: .infinity)
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .accessibilityIdentifier("consent-auto-read.progress")
        } else if let note = model.automaticReadNote {
            SettingsParts.errorBox(note)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .accessibilityIdentifier("consent-auto-read.result")
        }
    }
}

/// Full policy within the app, with no call to the external browser.
struct AIReadingPrivacySheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        AIReadingPrivacyPage { dismiss() }
            .accessibilityIdentifier("ai-reading-consent.privacy-sheet")
    }
}

private struct AIReadingPrivacyPage: UIViewControllerRepresentable {
    let close: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(close: close) }
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let page = SFSafariViewController(url: WebLink.privacy)
        page.delegate = context.coordinator
        return page
    }
    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let close: () -> Void
        init(close: @escaping () -> Void) { self.close = close }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { close() }
    }
}
