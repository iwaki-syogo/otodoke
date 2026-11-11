import Foundation
import Testing
@testable import Otodoke

@Suite("Consent at the forwarding and mail-action boundaries")
@MainActor
struct ConsentSettingsIntegrationTests {
    private actor Store: AIReadingConsentStoring {
        var result: LoadResult<AIReadingDecision>
        var nextGate: Gate?
        private(set) var saves = 0
        init(_ result: LoadResult<AIReadingDecision>) { self.result = result }
        func replace(_ result: LoadResult<AIReadingDecision>) { self.result = result }
        func holdNextLoad(_ gate: Gate) { nextGate = gate }
        func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> {
            let gate = nextGate; nextGate = nil
            if let gate { await gate.wait() }
            return result
        }
        func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> {
            saves += 1
            result = .loaded(allowed ? .allowed : .denied)
            return result
        }
    }

    private struct Setup {
        let fake: FakeSupabase
        let auth: AuthService
        let model: SettingsModel
        let store: Store
    }

    private func setup(_ result: LoadResult<AIReadingDecision> = .loaded(.allowed), load: Bool = true) async throws -> Setup {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("inbox_addresses", [["user_id": .string(FakeSupabase.me), "local_part": "sampleinbox"]])
        await fake.insert("emails", [SettingsRows.mail(30, ["classification": "forwarding_confirmation", "forwarding_confirm_url": .string(SettingsRows.google)])])
        let (provider, auth) = try await TestSession.signedIn(fake)
        let store = Store(result)
        let consent = AIReadingConsentModel(store: store, session: auth.session,
                                           loadFailureMessage: AIReadingConsentText.readFailed, saveFailureMessage: AIReadingConsentText.saveFailed)
        let model = SettingsModel(consent: consent, reader: SettingsReader(provider: provider),
                                  inbox: InboxAddressService(provider: provider), auth: auth,
                                  inboundDomain: fake.config.inboundDomain, changes: DataChanges(), now: { Date() })
        if load { await model.load() }
        return Setup(fake: fake, auth: auth, model: model, store: store)
    }

    private func expectHidden(_ model: SettingsModel) {
        #expect(!model.showsAddress)
        #expect(!model.addressCanBeCopied)
        #expect(model.address == nil)
        #expect(model.confirmURL == nil)
        #expect(!model.approvalWaiting)
        #expect(!model.pollsForApproval)
    }

    @Test(arguments: [AIReadingDecision.notDetermined, .denied])
    func noChoiceOrARefusalReadsNoAddressOrApproval(_ decision: AIReadingDecision) async throws {
        let s = try await setup(.loaded(decision))
        expectHidden(s.model)
        #expect(await s.fake.count("GET", "inbox_addresses") == 0)
        #expect(await s.fake.count("POST", "inbox_addresses") == 0)
        #expect(await s.fake.requests("GET", "emails").filter { $0.query("classification") == ["eq.forwarding_confirmation"] }.isEmpty)
        #expect(s.model.readingConsent.needsPrompt == (decision == .notDetermined))
    }

    @Test func anUnreadConsentIsAFailureRatherThanAPermissionOrARefusal() async throws {
        let s = try await setup(.failed)
        expectHidden(s.model)
        #expect(s.model.readingConsent.decision == nil)
        #expect(s.model.readingConsent.message == AIReadingConsentText.readFailed)
        #expect(await s.fake.count("GET", "inbox_addresses") == 0)
    }

    @Test func allowedWithdrawnAndAllowedAgainRevealsOnlyFreshAddressAndApproval() async throws {
        let s = try await setup()
        #expect(s.model.address?.value == "sampleinbox@\(s.fake.config.inboundDomain)")
        #expect(s.model.addressCanBeCopied)
        #expect(s.model.confirmURL?.absoluteString == SettingsRows.google)
        #expect(await s.model.chooseReadingConsent(false))
        expectHidden(s.model)
        #expect(await s.model.chooseReadingConsent(true))
        #expect(s.model.addressCanBeCopied)
        #expect(s.model.confirmURL?.absoluteString == SettingsRows.google)
        #expect(await s.store.saves == 2)
    }

    @Test func aWithdrawalFromAnotherDeviceIsReadEvenWithoutADataChange() async throws {
        let s = try await setup()
        #expect(s.model.addressCanBeCopied)
        await s.store.replace(.loaded(.denied))
        await s.model.sceneBecameActive()
        expectHidden(s.model)
        #expect(s.model.readingConsent.decision == .denied)
        #expect(await s.store.saves == 0)
    }

    @Test func delayedAddressAndApprovalCannotReturnAfterWithdrawal() async throws {
        let s = try await setup(load: false)
        let addressGate = Gate(), approvalGate = Gate()
        await s.fake.fail("GET", "inbox_addresses", with: .delay(addressGate))
        await s.fake.fail(where: { $0.query("classification") == ["eq.forwarding_confirmation"] }, with: .delay(approvalGate))
        let oldRead = Task { await s.model.load() }
        #expect(await waitFor { await s.fake.count("GET", "inbox_addresses") == 1 })
        #expect(await s.model.readingConsent.choose(false))
        expectHidden(s.model)
        addressGate.open(); approvalGate.open()
        await oldRead.value
        expectHidden(s.model)
    }

    @Test func allowedFirstKeyGuideStaysMountedWhileConsentIsRechecked() async throws {
        let s = try await setup()
        func landing() -> Landing {
            Landing.of(deciding: false, outcome: .created(keyID: "k1"),
                       guideClosed: s.model.readingConsent.decision == .denied)
        }
        #expect(landing() == .guide)
        let gate = Gate()
        await s.store.holdNextLoad(gate)
        let reload = Task { await s.model.sceneBecameActive() }
        #expect(await waitFor { await MainActor.run { s.model.readingConsent.isLoading } })
        #expect(s.model.readingConsent.decision == .allowed)
        #expect(!s.model.mayShowReadingAddress)
        #expect(landing() == .guide)
        gate.open(); await reload.value
        #expect(landing() == .guide)
        #expect(s.model.addressCanBeCopied)
    }

    @Test func aReadWithoutPermissionOpensTheChoiceWithoutSendingOrAutomaticallyRetrying() async throws {
        let s = try await setup(.loaded(.denied))
        let server = FakeMailServer.make(supabase: s.fake)
        let actions = MailActionsModel(api: MailActionsClient(baseURL: server.baseURL, session: server.urlSession),
                                       accessToken: { try? await s.auth.provider.auth.session.accessToken }, reload: {},
                                       mayRead: { s.model.mayShowReadingAddress }, requestReadingConsent: { s.model.requestReadingConsent() })
        await actions.readWaiting()
        #expect(s.model.requestsReadingConsent)
        #expect(await server.count("read-waiting") == 0)
        #expect(await s.model.chooseReadingConsent(true))
        #expect(!s.model.requestsReadingConsent)
        #expect(await server.count("read-waiting") == 0)
        await actions.readWaiting()
        #expect(await server.count("read-waiting") == 1)
    }

    @Test(arguments: [MailAPIFailure.aiConsentRequired, .unavailable])
    func anExplicitServerConsentFailureOffersRecoveryAndCannotReopenAfterSignOut(_ failure: MailAPIFailure) async throws {
        let s = try await setup()
        let server = FakeMailServer.make(supabase: s.fake)
        let gate = Gate()
        await server.hold("read-waiting", on: gate)
        await server.force("read-waiting", .answer(status: failure == .aiConsentRequired ? 403 : 503, ok: false,
                                                   code: failure == .aiConsentRequired ? "ai_consent_required" : "unavailable"))
        let actions = MailActionsModel(api: MailActionsClient(baseURL: server.baseURL, session: server.urlSession),
                                       accessToken: { try? await s.auth.provider.auth.session.accessToken }, reload: {},
                                       mayRead: { s.model.mayShowReadingAddress }, requestReadingConsent: { s.model.requestReadingConsent() })
        let read = Task { await actions.readWaiting() }
        #expect(await waitFor { await server.count("read-waiting") == 1 })
        s.model.clearForSignOut()
        gate.open(); await read.value
        #expect(!s.model.requestsReadingConsent)
        expectHidden(s.model)
        #expect(await server.count("read-waiting") == 1)
        #expect(actions.readNote == (failure == .unavailable ? AIReadingConsentText.readFailed : nil))
    }
}
