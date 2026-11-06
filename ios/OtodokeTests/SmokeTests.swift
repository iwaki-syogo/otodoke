import Foundation
import Testing
@testable import Otodoke

/// [Task 1] The app builds, the unit tests run inside it (TEST_HOST = Otodoke, so Bundle.main is the
/// app), and the Info.plist / resources the plan fixes are there.
@Suite("Smoke (task 1)")
struct SmokeTests {
    private var info: [String: Any] { Bundle.main.infoDictionary ?? [:] }

    @Test func runsInsideTheApp() {
        #expect(Bundle.main.bundleIdentifier == "com.iwakisyogo.otodoke")
    }

    @Test func displayNameAndVersion() {
        #expect(info["CFBundleDisplayName"] as? String == "Otodoke")
        #expect(info["CFBundleShortVersionString"] as? String == "1.0")
        #expect(Int(info["CFBundleVersion"] as? String ?? "") ?? 0 >= 1)
    }

    @Test func declaresNoNonExemptEncryption() {
        #expect(info["ITSAppUsesNonExemptEncryption"] as? Bool == false)
    }

    @Test func passesTheThreeSettingsThroughInfoPlist() {
        // Present as strings even when Secrets.xcconfig is missing (then empty, and AppConfig.load stops before login).
        for key in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "INBOUND_DOMAIN"] {
            #expect(info[key] is String, "\(key) in Info.plist")
        }
    }

    @Test func shipsThePrivacyManifest() {
        #expect(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy") != nil)
    }

    @Test func testBundleCarriesTheWebFixture() {
        // From the test bundle itself (no fallback to the source tree here).
        #expect(WebExpected.bundledURL() != nil)
    }
}
