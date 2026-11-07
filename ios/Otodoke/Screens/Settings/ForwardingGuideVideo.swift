// The explainer videos of 「メールの自動転送の設定」: the heading's length and the address that opens in Safari.
// The length is rounded the way the Web does it (GuideVideo in src/components/forwarding-steps.tsx): to the nearest
// half minute, never under half a minute. OtodokeTests/ForwardingGuideVideoTests.swift holds a table of the Web's
// results, and src/lib/__tests__/ios-forwarding-guide.test.ts runs the Web's own two lines to check that table.

import Foundation

enum ForwardingGuideVideo {
    /// The VoiceOver hint of the video row (it opens Safari).
    static let openHint = "Safari で動画を開きます"

    /// 89 -> "1 分半", 131 -> "2 分", 14 -> "半分".
    static func minutes(seconds: Int) -> String {
        let halves = max(0.5, (Double(seconds) / 30).rounded(.toNearestOrAwayFromZero) / 2)
        if halves == halves.rounded(.down) { return "\(Int(halves)) 分" }
        if halves < 1 { return "半分" }
        return "\(Int(halves.rounded(.down))) 分半"
    }

    /// 「動画で見る・約 2 分」, as the Web's heading.
    static func heading(seconds: Int) -> String {
        "\(ForwardingGuideText.videoLabel)・約 \(minutes(seconds: seconds))"
    }

    /// https://otodoke.app + path. Only a path on otodoke.app over https gives a URL.
    static func url(path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              let url = URL(string: WebLink.base.absoluteString + path),
              url.scheme?.lowercased() == "https",
              url.host?.lowercased() == WebLink.base.host?.lowercased()
        else { return nil }
        return url
    }
}
