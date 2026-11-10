// 「追跡ページを開く」 of src/app/app/parcels/[id]/tracking-button.tsx. A link opens in Safari; a form
// (Yamato, Seino) is posted in an in-app web view, as the Web posts it to a new tab; Sagawa walks
// through copying the number and opening the page. Only https pages are ever opened.

import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

struct TrackingLinkView: View {
    let action: TrackingAction
    @Environment(\.openURL) private var openURL
    @State private var showsPostedPage = false
    @State private var showsCopySteps = false

    var body: some View {
        Button {
            switch action {
            case let .open(url):
                if TrackingPage.isHttps(url) { openURL(url) }
            case .post:
                showsPostedPage = true
            case .copyThenOpen:
                showsCopySteps = true
            }
        } label: {
            Text("追跡ページを開く")
                .font(.caption.weight(.medium))
                .underline()
                .foregroundStyle(OtodokeColor.link)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showsPostedPage) {
            if case let .post(url, fields) = action {
                PostedPageSheet(url: url, fields: fields)
            }
        }
        .sheet(isPresented: $showsCopySteps) {
            if case let .copyThenOpen(url, number, shown, pageName, carrierName) = action {
                CopyThenOpenSheet(url: url, number: number, shown: shown, pageName: pageName, carrierName: carrierName)
            }
        }
    }
}

/// What the in-app web view sends.
enum TrackingPage {
    static func isHttps(_ url: URL) -> Bool {
        SafeURL.isHttpsUrl(url.absoluteString)
    }

    /// The Web's <form method="post"> as a request: application/x-www-form-urlencoded, fields in name
    /// order. nil for a URL that is not https.
    static func postRequest(url: URL, fields: [String: String]) -> URLRequest? {
        guard isHttps(url) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(formBody(fields).utf8)
        return request
    }

    /// name=value&... encoded as an HTML form does (space as +, everything but A–Z a–z 0–9 * - . _ escaped).
    static func formBody(_ fields: [String: String]) -> String {
        fields.sorted { $0.key < $1.key }
            .map { "\(formEncode($0.key))=\(formEncode($0.value))" }
            .joined(separator: "&")
    }

    enum NavigationDecision: Equatable { case allow, cancel, loadHere }

    /// What to do with a navigation. The main frame follows https only. A sub-frame (the carrier's
    /// page has empty iframes that load about:blank) may also load about:blank and about:srcdoc;
    /// everything else is cancelled. A link to a new window (no target frame) is loaded here.
    static func decision(for url: URL?, isMainFrame: Bool, hasTargetFrame: Bool) -> NavigationDecision {
        guard let url else { return .cancel }
        if isHttps(url) { return hasTargetFrame ? .allow : .loadHere }
        if hasTargetFrame, !isMainFrame {
            let text = url.absoluteString.lowercased()
            if text == "about:blank" || text == "about:srcdoc" { return .allow }
        }
        return .cancel
    }

    /// The sheet's title: the host of the page shown now (the web view has no address bar, so a page
    /// that moved to another site is never shown under the carrier's name).
    static func title(for url: URL?) -> String {
        url?.host() ?? ""
    }

    /// How long a copied tracking number stays on the pasteboard.
    static let copyLifetime: TimeInterval = 5 * 60

    /// This device only (not Universal Clipboard), and gone after copyLifetime.
    static func copyOptions(now: Date) -> [UIPasteboard.OptionsKey: Any] {
        [.localOnly: true, .expirationDate: now.addingTimeInterval(copyLifetime)]
    }

    @MainActor
    static func copy(_ number: String, to pasteboard: UIPasteboard = .general, now: Date = Date()) {
        pasteboard.setItems([[UTType.utf8PlainText.identifier: number]], options: copyOptions(now: now))
    }

    private static func formEncode(_ text: String) -> String {
        var out = ""
        for byte in Array(text.utf8) {
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2A, 0x2D, 0x2E, 0x5F:
                out.append(Character(Unicode.Scalar(byte)))
            case 0x20:
                out.append("+")
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }
}

/// The carrier's page, opened by posting the form, with 閉じる.
private struct PostedPageSheet: View {
    let url: URL
    let fields: [String: String]
    @Environment(\.dismiss) private var dismiss
    @State private var state = PostedWebView.LoadState.loading
    /// The page shown now (the title follows it).
    @State private var shownURL: URL?

    var body: some View {
        NavigationStack {
            ZStack {
                if let request = TrackingPage.postRequest(url: url, fields: fields) {
                    PostedWebView(request: request, state: $state, shownURL: $shownURL)
                }
                switch state {
                case .loading:
                    ProgressView()
                case .failed:
                    Text("読み込めませんでした")
                        .font(.subheadline)
                        .foregroundStyle(OtodokeColor.errorText)
                        .padding(16)
                        .frame(maxWidth: .infinity)
                        .background(Color(.systemBackground))
                case .loaded:
                    EmptyView()
                }
            }
            .navigationTitle(TrackingPage.title(for: shownURL ?? url))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }
}

/// A WKWebView that loads `request` once and then follows https pages only.
private struct PostedWebView: UIViewRepresentable {
    enum LoadState: Equatable { case loading, loaded, failed }

    let request: URLRequest
    @Binding var state: LoadState
    @Binding var shownURL: URL?

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state, shownURL: $shownURL)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing of the carrier's site is kept after the sheet closes.
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(request)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let state: Binding<LoadState>
        private let shownURL: Binding<URL?>

        init(state: Binding<LoadState>, shownURL: Binding<URL?>) {
            self.state = state
            self.shownURL = shownURL
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            switch TrackingPage.decision(for: action.request.url, isMainFrame: action.targetFrame?.isMainFrame == true, hasTargetFrame: action.targetFrame != nil) {
            case .allow:
                decisionHandler(.allow)
            case .loadHere:
                // A link to a new window opens here instead.
                webView.load(action.request)
                decisionHandler(.cancel)
            case .cancel:
                // Main frame: about:, javascript:, data:, tel: and http: pages are not opened.
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            if state.wrappedValue != .loaded { state.wrappedValue = .loading }
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            shownURL.wrappedValue = webView.url
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            shownURL.wrappedValue = webView.url
            state.wrappedValue = .loaded
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            fail(error)
        }

        private func fail(_ error: any Error) {
            let e = error as NSError
            // A load replaced by another one, or one cancelled by the policy above, is not a failure.
            if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
            if e.domain == WKErrorDomain && e.code == 102 { return } // frame load interrupted by policy change
            if state.wrappedValue != .loaded { state.wrappedValue = .failed }
        }
    }
}

/// For carriers that take no number from outside (Sagawa): copy the number, open the page, paste.
struct CopyThenOpenSheet: View {
    let url: URL
    let number: String
    let shown: String
    let pageName: String
    let carrierName: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            Text("\(carrierName)で追跡する")
                .font(.title3.bold())
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: 20) {
                step(1) {
                    HStack(spacing: 12) {
                        Text(shown)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            TrackingPage.copy(number)
                            copied = true
                        } label: {
                            // Both labels share the place, so the button keeps the wider one's width.
                            ZStack {
                                Text("コピー").opacity(copied ? 0 : 1)
                                Text("コピー ✓").opacity(copied ? 1 : 0)
                            }
                            .smallFramed(color: copied ? OtodokeColor.hex("#047857") : OtodokeColor.link,
                                         border: copied ? OtodokeColor.hex("#6ee7b7") : OtodokeColor.hex("#7dd3fc"))
                        }
                        .buttonStyle(.plain)
                    }
                }
                step(2) {
                    HStack(spacing: 12) {
                        Text(pageName)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            if TrackingPage.isHttps(url) { openURL(url) }
                        } label: {
                            Text("開く ↗").smallFramed(color: .primary, border: Color(.systemGray3))
                        }
                        .buttonStyle(.plain)
                    }
                }
                step(3) {
                    Text("送り状番号を貼り付けて『お問い合わせ開始』を押す")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.subheadline)
            .padding(.top, 20)
            Button {
                dismiss()
            } label: {
                Text("閉じる")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 24)
        }
        .padding(24)
        .presentationDetents([.medium, .large])
    }

    private func step(_ n: Int, @ViewBuilder _ content: () -> some View) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text("\(n)")
                .font(.subheadline.bold())
                .foregroundStyle(OtodokeColor.link)
                .frame(width: 24, height: 24)
                .background(OtodokeColor.hex("#e0f2fe"), in: Circle())
            content()
        }
    }
}

private extension View {
    /// The Web's SMALL: a framed control at the right end of a step row, at least 80 points wide.
    func smallFramed(color: Color, border: Color) -> some View {
        self
            .font(.subheadline.weight(.medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            .frame(minWidth: 80)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(border))
            .contentShape(Rectangle())
    }
}
