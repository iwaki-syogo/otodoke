// Cloudflare Turnstile on the login screen, way (a) of T1: loadHTMLString(html, baseURL:
// https://otodoke.app/), so location.origin is https://otodoke.app. The WebView keeps the default
// data store (`.default()`) and user agent. Release builds never set isInspectable to true.
//
// T1 (11/6): the widget never passed by itself on the simulator; it showed its checkbox, and a tap gave
// a token within a second. Every new generation (after each send) needs a new tap.

import Foundation
import SwiftUI
import UIKit
import WebKit

/// The constants of src/lib/turnstile.ts, in one place (a vitest checks they equal the TS values).
enum Turnstile {
    /// TURNSTILE_SITEKEY
    static let sitekey = "0x4AAAAAAF1bMWXBw0RF-dvv"
    /// TURNSTILE_SCRIPT_URL
    static let scriptURL = URL(string: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")!
    /// TURNSTILE_TOKEN_MAX_LENGTH
    static let tokenMaxLength = 2048
    /// TURNSTILE_WAIT_MS (10,000 ms): how long a press waits for the token.
    static let waitForToken: Duration = .milliseconds(10_000)
    /// The page the HTML is loaded as (way (a)).
    static let baseURL = URL(string: "https://otodoke.app/")!
    /// window.webkit.messageHandlers.<name>
    static let messageHandlerName = "otodokeTurnstile"
    /// The widget's place: the widget is 300 × 65 pt; T1 drew it in a 320 × 80 frame.
    static let minWidth: CGFloat = 320
    static let minHeight: CGFloat = 80

    /// The only origin a notice may come from.
    private static let origin = (scheme: "https", host: "otodoke.app")
    /// The only host a subframe may load from.
    private static let challengeHost = "challenges.cloudflare.com"

    /// [SEC-N2] The page's CSP: only Cloudflare's challenge script and frames, the inline script and style.
    static let contentSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'"

    /// The widget's page for one generation: renders explicitly with `sitekey`, and posts
    /// {"generation": n, "kind": "token"|"expired"|"error"|"timeout"|"unavailable", "token": "..."} to
    /// `messageHandlerName` from callback, expired-callback, error-callback (which returns true),
    /// timeout-callback and the script's onerror.
    static func html(generation: Int) -> String {
        """
        <!DOCTYPE html>
        <html lang="ja"><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
        <style>html,body{margin:0;padding:0;background:transparent;}</style>
        </head><body>
        <div id="widget"></div>
        <script>
        (function () {
          var generation = \(generation);
          function post(kind, token) {
            var notice = { generation: generation, kind: kind };
            if (typeof token === "string") notice.token = token;
            window.webkit.messageHandlers.\(messageHandlerName).postMessage(notice);
          }
          window.otodokeTurnstileLoaded = function () {
            if (!window.turnstile) { post("unavailable"); return; }
            try {
              window.turnstile.render("#widget", {
                sitekey: "\(sitekey)",
                theme: "light",
                language: "ja",
                callback: function (token) { post("token", token); },
                "expired-callback": function () { post("expired"); },
                "timeout-callback": function () { post("timeout"); },
                "error-callback": function () { post("error"); return true; }
              });
            } catch (e) {
              post("unavailable");
            }
          };
          window.otodokeTurnstileFailed = function () { post("unavailable"); };
        })();
        </script>
        <script src="\(scriptURL.absoluteString)" async defer onload="otodokeTurnstileLoaded()" onerror="otodokeTurnstileFailed()"></script>
        </body></html>
        """
    }

    /// A notice from the message handler, or nil when it must be ignored: not from the main frame,
    /// not from https://otodoke.app (port 443 or none), not the agreed shape, or a token that is empty
    /// after trimming or longer than `tokenMaxLength`. The token comes back trimmed.
    static func notice(body: Any, isMainFrame: Bool, originProtocol: String, originHost: String, originPort: Int) -> (generation: Int, event: TurnstileEvent)? {
        guard isMainFrame,
              originProtocol == origin.scheme, originHost == origin.host,
              originPort == 0 || originPort == 443
        else { return nil }
        guard let dict = body as? [String: Any],
              let generation = integer(dict["generation"]),
              let kind = dict["kind"] as? String
        else { return nil }
        switch kind {
        case "token":
            guard let raw = dict["token"] as? String else { return nil }
            let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            // Counted as the Web counts (JavaScript string length: UTF-16 units).
            guard !token.isEmpty, token.utf16.count <= tokenMaxLength else { return nil }
            return (generation, .token(token))
        case "expired": return (generation, .expired)
        case "error": return (generation, .error)
        case "timeout": return (generation, .timeout)
        case "unavailable": return (generation, .unavailable)
        default: return nil
        }
    }

    /// A whole number (WebKit hands JavaScript numbers over as NSNumber); not a string or a boolean.
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
        return value as? Int
    }

    /// createWebViewWith (the widget's 「プライバシー」「ヘルプ」): the URL to hand to Safari when it is https on
    /// cloudflare.com or below, else nil. The WebView itself always answers nil (no new window inside the app).
    static func externalURL(forNewWindow url: URL?) -> URL? {
        // [SEC-N1] Only cloudflare.com and its subdomains (the widget's 「プライバシー」「ヘルプ」), no user info.
        guard let url, url.scheme?.lowercased() == "https",
              url.user(percentEncoded: false) == nil, url.password(percentEncoded: false) == nil,
              let host = url.host(percentEncoded: false)?.lowercased(),
              host == "cloudflare.com" || host.hasSuffix(".cloudflare.com")
        else { return nil }
        return url
    }

    /// A subframe may load https://challenges.cloudflare.com/… (no other port, no user info).
    fileprivate static func isChallenge(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == challengeHost
            && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
    }
}

/// decidePolicyFor navigationAction. One policy per load of the HTML: the main frame may load
/// `Turnstile.baseURL` once (the loadHTMLString itself) and nothing else; a subframe may load only
/// https://challenges.cloudflare.com/…, about:blank and about:srcdoc.
struct TurnstileNavigationPolicy {
    private var loadedMainFrame = false

    init() {}

    mutating func allows(_ url: URL?, isMainFrame: Bool) -> Bool {
        guard let url else { return false }
        if isMainFrame {
            // A refused load does not use up the one load.
            guard !loadedMainFrame, url.absoluteString == Turnstile.baseURL.absoluteString else { return false }
            loadedMainFrame = true
            return true
        }
        if url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return true }
        return Turnstile.isChallenge(url)
    }
}

/// TURNSTILE_UNAVAILABLE_MESSAGE, shown where the widget would be when its script cannot load.
enum TurnstileText {
    static let unavailable = "確認を読み込めませんでした。ページを読み込み直すか、別のブラウザでお試しください。"
}

/// The widget on the login screen, in a place it can be seen and tapped. When its script cannot load,
/// TurnstileText.unavailable takes its place (as the Web's login form).
struct TurnstileView: View {
    let token: TurnstileToken

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if token.isUnavailable {
                Text(TurnstileText.unavailable)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35)))
            }
            // Kept in place while unavailable (hidden), so the next generation reuses the same WebView.
            TurnstileWebView(token: token, generation: token.generation)
                .frame(width: Turnstile.minWidth, height: token.isUnavailable ? 0 : Turnstile.minHeight)
                .opacity(token.isUnavailable ? 0 : 1)
                .accessibilityIdentifier("turnstile")
        }
    }
}

/// The WKWebView itself. A new `generation` loads the page anew (a new widget, a new navigation policy).
private struct TurnstileWebView: UIViewRepresentable {
    let token: TurnstileToken
    let generation: Int

    func makeCoordinator() -> Coordinator { Coordinator(token: token) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(WeakMessageHandler(context.coordinator), name: Turnstile.messageHandlerName)
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: Turnstile.minWidth, height: Turnstile.minHeight), configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        #if DEBUG
        webView.isInspectable = true
        #else
        webView.isInspectable = false
        #endif
        context.coordinator.load(generation, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.loadedGeneration != generation {
            context.coordinator.load(generation, in: webView)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Turnstile.messageHandlerName)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let token: TurnstileToken
        private(set) var loadedGeneration: Int?
        private var policy = TurnstileNavigationPolicy()

        init(token: TurnstileToken) {
            self.token = token
        }

        func load(_ generation: Int, in webView: WKWebView) {
            loadedGeneration = generation
            policy = TurnstileNavigationPolicy()
            let html = Turnstile.html(generation: generation)
            webView.loadHTMLString(html, baseURL: Turnstile.baseURL)
        }

        // MARK: WKScriptMessageHandler

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard let notice = Turnstile.notice(
                body: message.body,
                isMainFrame: message.frameInfo.isMainFrame,
                originProtocol: origin.protocol,
                originHost: origin.host,
                originPort: origin.port
            ), notice.generation == loadedGeneration
            else { return }
            token.receive(notice.event, generation: notice.generation)
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            // No target frame: a new window, which createWebViewWith never makes (it hands https to Safari).
            guard let frame = navigationAction.targetFrame else { return .allow }
            return policy.allows(navigationAction.request.url, isMainFrame: frame.isMainFrame) ? .allow : .cancel
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // The widget is gone with its process: start a new generation (the view loads it).
            token.reset()
        }

        // MARK: WKUIDelegate

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = Turnstile.externalURL(forNewWindow: navigationAction.request.url) {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }
}

/// WKUserContentController keeps its handlers strongly; this keeps the coordinator weakly.
@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
