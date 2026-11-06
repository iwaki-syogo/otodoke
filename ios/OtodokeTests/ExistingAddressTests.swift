import Foundation
import Testing
@testable import Otodoke

/// [existing address] Supabase answers a sign-up for a registered address with "sent" and sets no new password. The
/// waiting screen's sign-in (by itself or by the button) is then refused for credentials: the sign-in form comes
/// back with the address kept and a sentence that says the address is registered, the link to the reset and
/// RESET_LOSES_MAIL. Every other credentials answer keeps the Web's 「メールアドレスかパスワードが違います。」.
@Suite("Onboarding: the address was already registered")
@MainActor
struct ExistingAddressTests {
    private let clock = TestClock(Date(timeIntervalSince1970: 1_793_000_000))

    private func make(_ fake: FakeSupabase) -> LoginModel {
        let auth = PW.auth(fake, storage: InMemorySessionStorage())
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: []), now: clock.function, tokenWait: .milliseconds(100))
        model.email = FakeSupabase.email
        return model
    }

    /// A model that made an account and waits, for an address that already had one with another password.
    private func waitingOnRegisteredAddress() async -> (LoginModel, FakeSupabase) {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        return (model, fake)
    }

    private func expectExistingAddress(_ model: LoginModel) {
        #expect(!model.isWaitingForConfirmation)
        #expect(model.mode == .signIn)
        #expect(model.email == FakeSupabase.email)
        #expect(model.password.isEmpty)
        #expect(model.isExistingAddress)
        #expect(model.errorMessage == nil)
        #expect(model.notice == nil)
        #expect(model.shownNotice == nil)
        #expect(!model.isHoldingPassword)
    }

    @Test func theWordsAreTheWebs() {
        #expect(OnboardingText.existingAddress == "このアドレスは、もう登録されています。前に決めたパスワードでログインしてください。")
        #expect(OnboardingText.resetLosesMail == "パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。")
    }

    @Test func aTryByItselfRefusedForCredentialsSaysTheAddressIsRegistered() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        expectExistingAddress(model)
    }

    @Test func thePressedButtonSaysTheSame() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation(pressed: true)
        expectExistingAddress(model)
    }

    @Test func anOrdinarySignInWithAWrongPasswordKeepsTheWebsWords() async {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        let model = make(fake)
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.credentials)
        #expect(!model.isExistingAddress)
    }

    @Test func aSignInPressedAfterTheGuidanceClearsItAndSaysTheOrdinaryWords() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        #expect(model.isExistingAddress)
        model.password = PW.good
        await model.submit()
        #expect(!model.isExistingAddress)
        #expect(model.errorMessage == LoginText.credentials)
    }

    @Test func changingTheAddressClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        // The same address in other letters or with spaces is the same address.
        model.email = "  " + FakeSupabase.email.uppercased() + " "
        #expect(model.isExistingAddress)
        model.email = "other@example.com"
        #expect(!model.isExistingAddress)
    }

    @Test func switchingTheFormClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        model.setMode(.signUp)
        #expect(!model.isExistingAddress)
    }

    @Test func startingOverClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        model.startOver()
        #expect(!model.isExistingAddress)
    }

    @Test func leavingTheScreenClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        model.leaveWait()
        #expect(!model.isExistingAddress)
    }

    @Test func otherRefusalsOfTheWaitDoNotSayIt() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation(pressed: true)
        #expect(!model.isExistingAddress)
        #expect(model.isWaitingForConfirmation)
    }
}
