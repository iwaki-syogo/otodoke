import Foundation
import Testing
import WebKit
@testable import Otodoke

/// The in-app tracking page: the main frame follows https only, but the carrier's empty iframes
/// (about:blank) must not be cancelled as if they were a failure of the page.
@Suite("Tracking page: which navigations are allowed")
struct TrackingNavigationPolicyTests {
    private func decide(_ text: String?, main: Bool, target: Bool = true) -> TrackingPage.NavigationDecision {
        TrackingPage.decision(for: text.flatMap { URL(string: $0) }, isMainFrame: main, hasTargetFrame: target)
    }

    @Test("main frame: https allowed, http and other schemes cancelled")
    func mainFrame() {
        #expect(decide("https://toi.kuronekoyamato.co.jp/cgi-bin/tneko", main: true) == .allow)
        #expect(decide("http://example.com/", main: true) == .cancel)
        #expect(decide("about:blank", main: true) == .cancel)
        #expect(decide("javascript:alert(1)", main: true) == .cancel)
        #expect(decide("data:text/html,hi", main: true) == .cancel)
        #expect(decide("tel:0120", main: true) == .cancel)
        #expect(decide(nil, main: true) == .cancel)
    }

    @Test("sub-frame: about:blank, about:srcdoc and https allowed, the rest cancelled")
    func subFrame() {
        #expect(decide("about:blank", main: false) == .allow)
        #expect(decide("about:srcdoc", main: false) == .allow)
        #expect(decide("https://example.com/x", main: false) == .allow)
        #expect(decide("javascript:alert(1)", main: false) == .cancel)
        #expect(decide("data:text/html,hi", main: false) == .cancel)
        #expect(decide("http://example.com/", main: false) == .cancel)
        #expect(decide("about:blank#x", main: false) == .cancel)
    }

    @Test("a new window: https is loaded here, others cancelled (about:blank included)")
    func newWindow() {
        #expect(decide("https://example.com/", main: false, target: false) == .loadHere)
        #expect(decide("about:blank", main: false, target: false) == .cancel)
        #expect(decide("javascript:alert(1)", main: false, target: false) == .cancel)
    }
}

/// A live check against the real Yamato page. Off unless TEST_RUNNER_OTODOKE_LIVE_YAMATO=1 is set,
/// so the suite never depends on the network.
@MainActor
final class YamatoProbe: NSObject, WKNavigationDelegate {
    var oldPolicy = false
    var log: [String] = []
    var finished = false
    var failed = false

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let main = action.targetFrame?.isMainFrame == true
        let allow: Bool
        if oldPolicy {
            allow = url.map(TrackingPage.isHttps) ?? false
        } else {
            allow = TrackingPage.decision(for: url, isMainFrame: main, hasTargetFrame: action.targetFrame != nil) == .allow
        }
        log.append("policy main=\(main) allow=\(allow) url=\(url?.absoluteString ?? "nil")")
        decisionHandler(allow ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { log.append("didFinish \(webView.url?.absoluteString ?? "")"); finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        let e = error as NSError; log.append("didFail \(e.domain) \(e.code)"); failed = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        let e = error as NSError; log.append("didFailProvisional \(e.domain) \(e.code) \(e.userInfo[NSURLErrorFailingURLStringErrorKey] ?? "")"); failed = true
    }
}

@MainActor
@Suite("Yamato live page (opt-in)")
struct YamatoLiveTests {
    @Test("the real result page loads", .enabled(if: ProcessInfo.processInfo.environment["OTODOKE_LIVE_YAMATO"] == "1"))
    func live() async throws {
        for old in [true, false] {
            let probe = YamatoProbe()
            probe.oldPolicy = old
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 800), configuration: configuration)
            view.navigationDelegate = probe
            let request = try #require(TrackingPage.postRequest(url: URL(string: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko")!, fields: ["category": "1", "number01": "123456789012"]))
            view.load(request)
            for _ in 0..<300 where !probe.finished && !probe.failed { try await Task.sleep(for: .milliseconds(100)) }
            try await Task.sleep(for: .seconds(1))
            let text = "LIVE old=\(old) finished=\(probe.finished) failed=\(probe.failed)\n" + probe.log.joined(separator: "\n")
            if let dir = ProcessInfo.processInfo.environment["OTODOKE_LIVE_YAMATO_OUT"] {
                try text.write(toFile: "\(dir)/yamato-live-\(old ? "old" : "new").txt", atomically: true, encoding: .utf8)
            }
            if !old { #expect(probe.finished && !probe.failed) }
        }
    }
}

@Suite("Yamato: App Transport Security exception")
struct YamatoATSTests {
    @Test("only toi and track kuronekoyamato.co.jp are relaxed (forward secrecy), nothing global")
    func exceptionIsScoped() throws {
        let ats = try #require(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any])
        #expect(ats["NSAllowsArbitraryLoads"] == nil)
        let domains = try #require(ats["NSExceptionDomains"] as? [String: [String: Any]])
        let hosts = ["toi.kuronekoyamato.co.jp", "track.kuronekoyamato.co.jp"]
        #expect(Set(domains.keys) == Set(hosts))
        for host in hosts {
            let entry = try #require(domains[host])
            #expect(entry["NSExceptionRequiresForwardSecrecy"] as? Bool == false)
            #expect(entry["NSIncludesSubdomains"] == nil)
            #expect(entry["NSExceptionAllowsInsecureHTTPLoads"] == nil)
        }
    }
    private final class BundleToken {}
}
