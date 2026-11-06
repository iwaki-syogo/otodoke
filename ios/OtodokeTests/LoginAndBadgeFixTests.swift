import Foundation
import Testing
@testable import Otodoke

/// [Fix N7] Back on the address field, the same address still waits out the 60 seconds.
@Suite("LoginModel resend wait (fix N7)")
@MainActor
struct LoginResendWaitTests {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, clock: TestClock) -> LoginModel {
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        return LoginModel(auth: auth, launch: LaunchOptions(arguments: ["Otodoke"]), now: clock.function)
    }

    @Test func theSameAddressAgainWithinSixtySecondsSendsNothing() async {
        let fake = FakeSupabase.make()
        let clock = TestClock(start)
        let model = make(fake, clock: clock)
        model.email = "qa@example.com"
        await model.sendCode()
        model.changeAddress()
        #expect(model.step == .email)
        clock.advance(seconds: 20)
        model.email = " QA@example.com "
        await model.sendCode()
        #expect(await fake.count("POST", "otp") == 1)
        // Back to the code already sent, with the wait still running.
        #expect(model.step == .code(email: "qa@example.com"))
        #expect(model.resendWaitSeconds() == 40)
        #expect(model.errorMessage == nil)
    }

    @Test func theSameAddressAfterSixtySecondsSends() async {
        let fake = FakeSupabase.make()
        let clock = TestClock(start)
        let model = make(fake, clock: clock)
        model.email = "qa@example.com"
        await model.sendCode()
        model.changeAddress()
        clock.advance(seconds: 60)
        await model.sendCode()
        #expect(await fake.count("POST", "otp") == 2)
    }

    @Test func anotherAddressSendsAtOnce() async {
        let fake = FakeSupabase.make()
        let clock = TestClock(start)
        let model = make(fake, clock: clock)
        model.email = "qa@example.com"
        await model.sendCode()
        model.changeAddress()
        clock.advance(seconds: 5)
        model.email = "qa2@example.com"
        await model.sendCode()
        #expect(await fake.count("POST", "otp") == 2)
        #expect(model.step == .code(email: "qa2@example.com"))
    }
}

/// [Fix N6] The status pills keep the Web's colours in light mode and read well in dark mode.
@Suite("Badge colours (fix N6)")
@MainActor
struct BadgeColourTests {
    nonisolated private static func luminance(_ hex: String) -> Double {
        let v = UInt32(hex.dropFirst(), radix: 16)!
        func channel(_ c: UInt32) -> Double {
            let s = Double(c) / 255
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel((v >> 16) & 0xFF) + 0.7152 * channel((v >> 8) & 0xFF) + 0.0722 * channel(v & 0xFF)
    }

    nonisolated private static func contrast(_ a: String, _ b: String) -> Double {
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    nonisolated static let statuses = ["ordered", "shipped", "out_for_delivery", "attempted", "delivered", "cancelled", "unknown"]

    @Test func lightModeIsTheWebsStatusStyle() {
        #expect(StatusBadge.style("ordered").light == ("#f5f5f5", "#404040"))
        #expect(StatusBadge.style("shipped").light == ("#e0f2fe", "#075985"))
        #expect(StatusBadge.style("out_for_delivery").light == ("#fef3c7", "#78350f"))
        #expect(StatusBadge.style("attempted").light == ("#fee2e2", "#991b1b"))
        #expect(StatusBadge.style("delivered").light == ("#d1fae5", "#065f46"))
        #expect(StatusBadge.style("cancelled").light == ("#f5f5f5", "#737373"))
    }

    @Test(arguments: statuses)
    func darkModeIsDarkAndReadable(status: String) {
        let dark = StatusBadge.style(status).dark
        // A dark pill (it sits on the black list, not a light patch on it) with text at WCAG AA.
        #expect(Self.luminance(dark.background) < 0.05, "\(status)")
        #expect(Self.contrast(dark.background, dark.text) >= 4.5, "\(status)")
    }
}
