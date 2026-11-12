import SafariServices
import SwiftUI

enum AIReadingConsentText {
    static let title = "メールの読み取り"
    static let body = "届いたメールは、Anthropic の Claude で読み取ります。"
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
}

/// Explicit choice before any forwarding address is revealed. Manual parcels and samples remain usable.
struct AIReadingConsentView: View {
    let model: AIReadingConsentModel
    let saveChoice: @MainActor (Bool) async -> Bool
    var onChanged: @MainActor () async -> Void = {}
    var openManual: (() -> Void)?
    var openSample: (() -> Void)?
    @State private var showsPrivacy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(AIReadingConsentText.title)
                    .font(.title.bold())
                    .accessibilityIdentifier("ai-reading-consent.title")
                Text(AIReadingConsentText.body)
                    .fixedSize(horizontal: false, vertical: true)
                Button(AIReadingConsentText.privacy) { showsPrivacy = true }
                    .accessibilityIdentifier("ai-reading-consent.privacy")
                if model.isLoading || model.isSaving { ProgressView() }
                if let message = model.message {
                    SettingsParts.errorBox(message)
                        .accessibilityIdentifier("ai-reading-consent.error")
                    Button(AIReadingConsentText.retry) { Task { await model.load() } }
                        .accessibilityIdentifier("ai-reading-consent.retry")
                        .disabled(model.isLoading || model.isSaving)
                }
                if model.decision != nil {
                    VStack(spacing: 12) {
                        choice(AIReadingConsentText.allow, allowed: true, id: "ai-reading-consent.allow")
                        choice(AIReadingConsentText.deny, allowed: false, id: "ai-reading-consent.deny")
                    }
                    .disabled(model.isSaving || model.isLoading)
                }
                if let openManual {
                    Button(AIReadingConsentText.manual, action: openManual)
                        .accessibilityIdentifier("ai-reading-consent.manual")
                }
                if let openSample {
                    Button(AIReadingConsentText.sample, action: openSample)
                        .accessibilityIdentifier("ai-reading-consent.sample")
                }
            }
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(24)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .sheet(isPresented: $showsPrivacy) { AIReadingPrivacySheet() }
    }

    private func choice(_ title: String, allowed: Bool, id: String) -> some View {
        Button {
            Task { if await saveChoice(allowed) { await onChanged() } }
        } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier(id)
    }
}

struct AIReadingConsentSettingsControl: View {
    let model: SettingsModel
    @State private var showsChoice = false
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
                    showsChoice = true
                }
            }
            .disabled(model.readingConsent.isLoading || model.readingConsent.isSaving)
            .accessibilityIdentifier("settings.ai-reading")
            if model.readingConsent.isLoading || model.readingConsent.isSaving { ProgressView() }
        }
        .sheet(isPresented: $showsChoice) {
            NavigationStack {
                AIReadingConsentView(model: model.readingConsent, saveChoice: model.chooseReadingConsent, onChanged: {
                    showsChoice = false
                })
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(ManualParcelText.close) { showsChoice = false } } }
            }
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
