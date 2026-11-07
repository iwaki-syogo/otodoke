import XCTest
@testable import Otodoke

/// The Web's results for GuideVideo's rounding (src/app/guide/forwarding/page.tsx). src/lib/__tests__/ios-forwarding-guide.test.ts
/// runs the Web's own two lines and fails when a row of this table differs from them.
final class ForwardingGuideVideoTests: XCTestCase {
    // WEB-TABLE-BEGIN
    static let webTable: [(seconds: Int, minutes: String)] = [
        (0, "半分"),
        (14, "半分"),
        (15, "半分"),
        (44, "半分"),
        (45, "1 分"),
        (75, "1 分半"),
        (89, "1 分半"),
        (90, "1 分半"),
        (91, "1 分半"),
        (92, "1 分半"),
        (99, "1 分半"),
        (104, "1 分半"),
        (105, "2 分"),
        (131, "2 分"),
        (150, "2 分半"),
        (600, "10 分"),
    ]
    // WEB-TABLE-END

    func testMinutesMatchTheWeb() {
        for row in Self.webTable {
            XCTAssertEqual(ForwardingGuideVideo.minutes(seconds: row.seconds), row.minutes, "\(row.seconds) seconds")
        }
    }

    func testEachServiceHeadingAndAddress() {
        let headings = ForwardingGuideText.services.compactMap { $0.video.map { ForwardingGuideVideo.heading(seconds: $0.seconds) } }
        XCTAssertEqual(headings, ["動画で見る・約 2 分", "動画で見る・約 1 分半", "動画で見る・約 1 分半"])
        let urls = ForwardingGuideText.services.compactMap { $0.video.flatMap { ForwardingGuideVideo.url(path: $0.path) } }
        XCTAssertEqual(urls.map(\.absoluteString), [
            "https://otodoke.app/guide/videos/otodoke-fwd-gmail-720.mp4",
            "https://otodoke.app/guide/videos/otodoke-fwd-icloud-720.mp4",
            "https://otodoke.app/guide/videos/otodoke-fwd-outlook-720.mp4",
        ])
    }

    func testOnlyOtodokeAppOverHttpsOpens() {
        XCTAssertNil(ForwardingGuideVideo.url(path: "//evil.example/x.mp4"))
        XCTAssertNil(ForwardingGuideVideo.url(path: "https://evil.example/x.mp4"))
        XCTAssertNil(ForwardingGuideVideo.url(path: "@evil.example/x"))
        XCTAssertNil(ForwardingGuideVideo.url(path: ""))
        XCTAssertEqual(ForwardingGuideVideo.url(path: "/a.mp4")?.host, "otodoke.app")
    }
}
