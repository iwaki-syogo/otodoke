import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 2] Cloudflare Turnstile on the login screen, way (a) (11/6 13:35): the widget's HTML
/// loaded with baseURL https://otodoke.app/. The WebView's decisions are pure functions here (the WebKit
/// objects cannot be made in a unit test): which notices are taken, which frames may load, where a new
/// window goes. The constants equal src/lib/turnstile.ts (a vitest compares the Swift source too).
@Suite("Turnstile widget rules (batch 2, task 2)")
struct TurnstileRulesTests {
    private static var good: [String: Any] { ["generation": 3, "kind": "token", "token": "tok-abc"] }

    private func notice(_ body: Any, main: Bool = true, scheme: String = "https", host: String = "otodoke.app", port: Int = 0) -> (generation: Int, event: TurnstileEvent)? {
        Turnstile.notice(body: body, isMainFrame: main, originProtocol: scheme, originHost: host, originPort: port)
    }

    // MARK: constants

    @Test func theConstantsOfTheWeb() {
        #expect(Turnstile.sitekey == "0x4AAAAAAF1bMWXBw0RF-dvv")
        #expect(Turnstile.scriptURL.absoluteString == "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")
        #expect(Turnstile.tokenMaxLength == 2048)
        #expect(Turnstile.waitForToken == .seconds(10))
        #expect(Turnstile.baseURL.absoluteString == "https://otodoke.app/")
        #expect(!Turnstile.messageHandlerName.isEmpty)
        #expect(TurnstileText.unavailable == "確認を読み込めませんでした。ページを読み込み直すか、別のブラウザでお試しください。")
    }

    @Test func theWidgetHasRoomToBeTapped() {
        #expect(Turnstile.minWidth >= 300)
        #expect(Turnstile.minHeight >= 65)
    }

    // MARK: the page

    @Test func thePageRendersTheWidgetAndReportsEveryCallbackThroughOneHandler() {
        let html = Turnstile.html(generation: 7)
        #expect(html.contains(Turnstile.sitekey))
        #expect(html.contains(Turnstile.scriptURL.absoluteString))
        #expect(html.contains("window.webkit.messageHandlers.\(Turnstile.messageHandlerName).postMessage"))
        for callback in ["callback", "expired-callback", "error-callback", "timeout-callback"] {
            #expect(html.contains(callback), "\(callback)")
        }
        // error-callback returns true (Turnstile shows its own error state and does not throw).
        #expect(html.range(of: #"error-callback['"]?\s*:[^}]*return\s+true"#, options: .regularExpression) != nil)
        // The script failing to load is reported too (no token will come).
        #expect(html.contains("onerror"))
        #expect(html.contains("unavailable"))
        // The generation travels with every notice.
        #expect(html.contains("7"))
        #expect(Turnstile.html(generation: 8) != html)
        #expect(!html.contains("http://"))
    }

    // MARK: notices

    @Test func takesATokenFromTheMainFrameOfOtodoke() {
        let n = notice(Self.good)
        #expect(n?.generation == 3)
        #expect(n?.event == .token("tok-abc"))
        #expect(notice(Self.good, port: 443)?.event == .token("tok-abc"))
        #expect(notice(["generation": NSNumber(value: 3), "kind": "token", "token": "tok-abc"] as [String: Any])?.generation == 3)
    }

    @Test func theTokenIsTrimmed() {
        #expect(notice(["generation": 1, "kind": "token", "token": "  tok \n"] as [String: Any])?.event == .token("tok"))
    }

    @Test func theOtherKindsComeThroughTheSameHandler() {
        #expect(notice(["generation": 2, "kind": "expired"] as [String: Any])?.event == .expired)
        #expect(notice(["generation": 2, "kind": "error"] as [String: Any])?.event == .error)
        #expect(notice(["generation": 2, "kind": "timeout"] as [String: Any])?.event == .timeout)
        #expect(notice(["generation": 2, "kind": "unavailable"] as [String: Any])?.event == .unavailable)
    }

    @Test func refusesNoticesFromElsewhere() {
        // Positive control first: the same body is taken from the right place.
        #expect(notice(Self.good) != nil)
        #expect(notice(Self.good, main: false) == nil)
        #expect(notice(Self.good, scheme: "http") == nil)
        #expect(notice(Self.good, host: "otodoke.app.evil.example") == nil)
        #expect(notice(Self.good, host: "challenges.cloudflare.com") == nil)
        #expect(notice(Self.good, host: "evil.example") == nil)
        #expect(notice(Self.good, port: 8443) == nil)
    }

    @Test func refusesATokenOverTheLimit() {
        let atLimit = String(repeating: "a", count: 2048)
        let over = String(repeating: "a", count: 2049)
        #expect(notice(["generation": 1, "kind": "token", "token": atLimit] as [String: Any])?.event == .token(atLimit))
        #expect(notice(["generation": 1, "kind": "token", "token": over] as [String: Any]) == nil)
        // Counted after trimming.
        #expect(notice(["generation": 1, "kind": "token", "token": " " + atLimit + " "] as [String: Any])?.event == .token(atLimit))
    }

    @Test func refusesBodiesOfAnotherShape() {
        #expect(notice(["generation": 1, "kind": "token", "token": "   "] as [String: Any]) == nil)
        #expect(notice(["generation": 1, "kind": "token"] as [String: Any]) == nil)
        #expect(notice(["generation": 1, "kind": "token", "token": 5] as [String: Any]) == nil)
        #expect(notice(["kind": "token", "token": "t"] as [String: Any]) == nil)
        #expect(notice(["generation": "1", "kind": "token", "token": "t"] as [String: Any]) == nil)
        #expect(notice(["generation": 1, "kind": "solved", "token": "t"] as [String: Any]) == nil)
        #expect(notice("tok-abc") == nil)
        #expect(notice(NSNull()) == nil)
    }

    // MARK: navigation

    @Test func theMainFrameLoadsOtodokeOnceAndNothingElse() {
        var policy = TurnstileNavigationPolicy()
        let r1 = policy.allows(URL(string: "javascript:alert(1)"), isMainFrame: true)
        #expect(r1 == false)
        // A refusal does not use up the one load.
        let r2 = policy.allows(URL(string: "https://otodoke.app/"), isMainFrame: true)
        #expect(r2 == true)
        let r3 = policy.allows(URL(string: "https://otodoke.app/"), isMainFrame: true)
        #expect(r3 == false)
        let r4 = policy.allows(URL(string: "https://otodoke.app/app"), isMainFrame: true)
        #expect(r4 == false)
        let r5 = policy.allows(URL(string: "https://challenges.cloudflare.com/turnstile/v0/api.js"), isMainFrame: true)
        #expect(r5 == false)
        let r6 = policy.allows(URL(string: "https://evil.example/"), isMainFrame: true)
        #expect(r6 == false)
        let r7 = policy.allows(nil, isMainFrame: true)
        #expect(r7 == false)
    }

    @Test func theMainFrameMayNotLoadAnotherPageFirst() {
        var policy = TurnstileNavigationPolicy()
        let r8 = policy.allows(URL(string: "https://otodoke.app.evil.example/"), isMainFrame: true)
        #expect(r8 == false)
        let r9 = policy.allows(URL(string: "http://otodoke.app/"), isMainFrame: true)
        #expect(r9 == false)
        let r10 = policy.allows(URL(string: "https://otodoke.app/auth/turnstile-app"), isMainFrame: true)
        #expect(r10 == false)
    }

    @Test func subframesOnlyCloudflareAndBlankPages() {
        var policy = TurnstileNavigationPolicy()
        let r11 = policy.allows(URL(string: "https://otodoke.app/"), isMainFrame: true)
        #expect(r11)
        let allowed = [
            "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAAAAF1bMWXBw0RF-dvv/light/fbE/new/normal/auto/",
            "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
            "about:blank",
            "about:srcdoc",
        ]
        for url in allowed {
            let r12 = policy.allows(URL(string: url), isMainFrame: false)
            #expect(r12, "\(url)")
        }
        let refused = [
            "http://challenges.cloudflare.com/cdn-cgi/x",
            "https://challenges.cloudflare.com.evil.example/cdn-cgi/x",
            "https://challenges.cloudflare.com@evil.example/cdn-cgi/x",
            "https://cloudflare.com/",
            "https://otodoke.app/",
            "https://evil.example/",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "about:config",
        ]
        for url in refused {
            let r13 = policy.allows(URL(string: url), isMainFrame: false)
            #expect(r13 == false, "\(url)")
        }
        let r14 = policy.allows(nil, isMainFrame: false)
        #expect(r14 == false)
    }

    @Test func aNewWindowGoesToSafariOnlyWhenHttps() {
        let privacy = URL(string: "https://www.cloudflare.com/privacypolicy/")!
        #expect(Turnstile.externalURL(forNewWindow: privacy) == privacy)
        #expect(Turnstile.externalURL(forNewWindow: URL(string: "http://www.cloudflare.com/")) == nil)
        #expect(Turnstile.externalURL(forNewWindow: URL(string: "javascript:alert(1)")) == nil)
        #expect(Turnstile.externalURL(forNewWindow: nil) == nil)
    }
}

/// [Batch 2, task 2] Where the token waits: one generation at a time, taken once, cleared when it
/// expires or fails, reset after every send.
@Suite("TurnstileToken (batch 2, task 2)")
@MainActor
struct TurnstileTokenTests {
    @Test func startsEmpty() {
        let t = TurnstileToken()
        #expect(t.generation == 0)
        #expect(t.hasToken == false)
        #expect(t.isSettled == false)
        #expect(t.take() == nil)
    }

    @Test func holdsATokenOfTheCurrentGeneration() {
        let t = TurnstileToken()
        t.receive(.token("tok"), generation: 0)
        #expect(t.hasToken)
        #expect(t.isSettled)
        #expect(t.take() == "tok")
        // Taken once: the same token is never sent twice.
        #expect(t.take() == nil)
        #expect(t.hasToken == false)
    }

    @Test func ignoresAnotherGeneration() {
        let t = TurnstileToken()
        t.receive(.token("future"), generation: 1)
        #expect(t.hasToken == false)
        t.receive(.token("now"), generation: 0)
        #expect(t.take() == "now")
    }

    @Test func expiredErrorAndTimeoutClearTheToken() {
        for event in [TurnstileEvent.expired, .error, .timeout] {
            let t = TurnstileToken()
            t.receive(.token("tok"), generation: 0)
            t.receive(event, generation: 0)
            #expect(t.hasToken == false, "\(event)")
            #expect(t.take() == nil, "\(event)")
        }
    }

    @Test func anOldGenerationCannotClearOrSetTheToken() {
        let t = TurnstileToken()
        t.reset()
        t.receive(.token("new"), generation: 1)
        t.receive(.expired, generation: 0)
        #expect(t.hasToken)
        t.receive(.token("old"), generation: 0)
        #expect(t.take() == "new")
    }

    @Test func resetMovesTheGenerationOnAndAsksForANewWidget() {
        let t = TurnstileToken()
        t.receive(.token("tok"), generation: 0)
        t.reset()
        #expect(t.generation == 1)
        #expect(t.resetCount == 1)
        #expect(t.hasToken == false)
        t.receive(.token("late"), generation: 0)
        #expect(t.hasToken == false)
    }

    @Test func unavailableSettlesWithoutAToken() {
        let t = TurnstileToken()
        t.receive(.unavailable, generation: 0)
        #expect(t.isUnavailable)
        #expect(t.isSettled)
        #expect(t.hasToken == false)
        #expect(t.take() == nil)
    }

    @Test func waitsUntilTheTokenComes() async {
        let t = TurnstileToken()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(50))
            t.receive(.token("tok"), generation: 0)
        }
        #expect(await t.waitUntilSettled(timeout: .seconds(5)) == true)
        #expect(t.take() == "tok")
    }

    @Test func stopsWaitingAtTheTimeout() async {
        let t = TurnstileToken()
        let clock = ContinuousClock()
        let started = clock.now
        #expect(await t.waitUntilSettled(timeout: .milliseconds(200)) == false)
        let waited = clock.now - started
        #expect(waited >= .milliseconds(150))
        #expect(waited < .seconds(3))
    }

    @Test func doesNotWaitWhenSettled() async {
        let t = TurnstileToken()
        t.receive(.unavailable, generation: 0)
        let clock = ContinuousClock()
        let started = clock.now
        #expect(await t.waitUntilSettled(timeout: .seconds(30)) == true)
        #expect(clock.now - started < .seconds(1))
    }
}
