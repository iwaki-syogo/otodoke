// TDD-STUB(task 2) — the names and signatures below are the agreed API; the bodies are placeholders
// for the implementer (who also writes the WKWebView and its coordinator here). Remove this marker
// line once the bodies are written.
//
// Cloudflare Turnstile on the login screen, way (a) of T1: loadHTMLString(html, baseURL:
// https://otodoke.app/), so location.origin is https://otodoke.app. The WebView keeps the default
// data store (`.default()`) and user agent. Release builds never set isInspectable to true.

import Foundation
import SwiftUI

/// The constants of src/lib/turnstile.ts, in one place (a vitest checks they equal the TS values).
enum Turnstile {
    /// TURNSTILE_SITEKEY
    static let sitekey = ""
    /// TURNSTILE_SCRIPT_URL
    static let scriptURL = URL(string: "https://example.invalid/")!
    /// TURNSTILE_TOKEN_MAX_LENGTH
    static let tokenMaxLength = 0
    /// TURNSTILE_WAIT_MS (10,000 ms): how long a press waits for the token.
    static let waitForToken: Duration = .zero
    /// The page the HTML is loaded as (way (a)).
    static let baseURL = URL(string: "https://example.invalid/")!
    /// window.webkit.messageHandlers.<name>
    static let messageHandlerName = ""
    /// The widget's place: at least 300 × 65 pt.
    static let minWidth: CGFloat = 0
    static let minHeight: CGFloat = 0

    /// The widget's page for one generation: renders explicitly with `sitekey`, and posts
    /// {"generation": n, "kind": "token"|"expired"|"error"|"timeout"|"unavailable", "token": "..."} to
    /// `messageHandlerName` from callback, expired-callback, error-callback (which returns true),
    /// timeout-callback and the script's onerror.
    static func html(generation: Int) -> String { "" }

    /// A notice from the message handler, or nil when it must be ignored: not from the main frame,
    /// not from https://otodoke.app (port 443 or none), not the agreed shape, or a token that is empty
    /// after trimming or longer than `tokenMaxLength`. The token comes back trimmed.
    static func notice(body: Any, isMainFrame: Bool, originProtocol: String, originHost: String, originPort: Int) -> (generation: Int, event: TurnstileEvent)? {
        nil
    }

    /// createWebViewWith (the widget's 「プライバシー」「ヘルプ」): the URL to hand to Safari when it is
    /// https, else nil. The WebView itself always answers nil (no new window inside the app).
    static func externalURL(forNewWindow url: URL?) -> URL? { nil }
}

/// decidePolicyFor navigationAction. One policy per load of the HTML: the main frame may load
/// `Turnstile.baseURL` once (the loadHTMLString itself) and nothing else; a subframe may load only
/// https://challenges.cloudflare.com/…, about:blank and about:srcdoc.
struct TurnstileNavigationPolicy {
    init() {}

    mutating func allows(_ url: URL?, isMainFrame: Bool) -> Bool { false }
}

/// TURNSTILE_UNAVAILABLE_MESSAGE, shown where the widget would be when its script cannot load.
enum TurnstileText {
    static let unavailable = ""
}

/// The widget on the login screen. Placeholder: the implementer puts the WKWebView here.
struct TurnstileView: View {
    let token: TurnstileToken

    var body: some View {
        Color.clear.frame(minWidth: Turnstile.minWidth, minHeight: Turnstile.minHeight)
    }
}
