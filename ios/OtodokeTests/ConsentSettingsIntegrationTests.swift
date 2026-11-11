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
        private var choiceRevision = 0
        private var saveFailure = false
        func failSaving() { saveFailure = true }
        init(_ result: LoadResult<AIReadingDecision>) { self.result = result }
        func replace(_ result: LoadResult<AIReadingDecision>) { self.result = result }
        func holdNextLoad(_ gate: Gate) { nextGate = gate }
        func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> {
            let gate = nextGate; nextGate = nil
            if let gate { await gate.wait() }
            return result
        }
        func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingConsentSaveReceipt> {
            saves += 1
            guard !saveFailure else { return .failed }
            let next: AIReadingDecision = allowed ? .allowed : .denied
            if result.value != next { choiceRevision += 1 }
            result = .loaded(next)
            return .loaded(AIReadingConsentSaveReceipt(decision: next,
                decidedAt: String(format: "2026-11-12T00:00:00.%06d+00:00", choiceRevision), stamp: stamp))
        }
    }

    private actor ReadAPI: MailActionsAPI {
        struct Answer: Sendable {
            var failure: MailAPIFailure?
            var stopped = false
            var limit = false
            var partial = false
        }
        let fake: FakeSupabase
        private(set) var receipts: [AIReadingConsentSaveReceipt] = []
        private(set) var manualCalls = 0
        private var gates: [Int: Gate] = [:]
        private var answers: [Int: Answer] = [:]
        private var manualGate: Gate?
        private var manualAnswer = Answer()
        func holdManual(_ gate: Gate) { manualGate = gate }
        func answerManual(_ value: Answer) { manualAnswer = value }
        init(_ fake: FakeSupabase) { self.fake = fake }
        func hold(_ n: Int, on gate: Gate) { gates[n] = gate }
        func answer(_ n: Int, _ value: Answer) { answers[n] = value }
        func markParcel(id: String, accessToken: String) async throws(MailAPIFailure) -> MarkParcelOutcome { .remembered }
        func readWaiting(accessToken: String) async throws(MailAPIFailure) -> ReadWaitingResult {
            manualCalls += 1
            if let manualGate { await manualGate.wait() }
            return try await complete(manualAnswer)
        }
        func readWaiting(afterConsent receipt: AIReadingConsentSaveReceipt, accessToken: String) async throws(MailAPIFailure) -> ReadWaitingResult {
            receipts.append(receipt)
            let n = receipts.count
            if let gate = gates[n] { await gate.wait() }
            return try await complete(answers[n] ?? Answer())
        }
        private func complete(_ answer: Answer) async throws(MailAPIFailure) -> ReadWaitingResult {
            if (!answer.stopped && answer.failure == nil) || answer.partial {
                if await fake.row("parcels", id: Rows.id(98_001)) == nil {
                    await fake.insert("parcels", [Rows.parcel(98_001, ["title": "架空の自動読取の本"])])
                }
                await fake.setUnreadEmails(answer.limit || answer.partial ? 1 : 0)
            }
            if let failure = answer.failure { throw failure }
            return ReadWaitingResult(stopped: answer.stopped, overLimit: answer.limit)
        }
    }

    @MainActor private final class Changes { var announcements = 0; var reloads = 0 }

    private struct Setup {
        let fake: FakeSupabase
        let auth: AuthService
        let model: SettingsModel
        let store: Store
        let api: ReadAPI
        let changes: Changes
    }

    private func setup(_ result: LoadResult<AIReadingDecision> = .loaded(.allowed), load: Bool = true, tokenGate: Gate? = nil, tokenAvailable: Bool = true) async throws -> Setup {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("inbox_addresses", [["user_id": .string(FakeSupabase.me), "local_part": "sampleinbox"]])
        await fake.insert("emails", [SettingsRows.mail(30, ["classification": "forwarding_confirmation", "forwarding_confirm_url": .string(SettingsRows.google)])])
        await fake.setUnreadEmails(2)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let store = Store(result)
        let consent = AIReadingConsentModel(store: store, session: auth.session,
                                           loadFailureMessage: AIReadingConsentText.readFailed, saveFailureMessage: AIReadingConsentText.saveFailed)
        let model = SettingsModel(consent: consent, reader: SettingsReader(provider: provider),
                                  inbox: InboxAddressService(provider: provider), auth: auth,
                                  inboundDomain: fake.config.inboundDomain, changes: DataChanges(), now: { Date() })
        let api = ReadAPI(fake), changes = Changes()
        model.mailActions = MailActionsModel(api: api, accessToken: {
            if let tokenGate { await tokenGate.wait() }
            return tokenAvailable ? try? await provider.auth.session.accessToken : nil
        }, reload: {
            changes.reloads += 1
            await model.load()
        }, announceChange: { changes.announcements += 1 },
        mayRead: { consent.mayShowAddress && !model.requestsReadingConsent }, requestReadingConsent: { model.requestReadingConsent() },
        isCurrent: { consent.isActiveSession }, authorizeAfterConsent: { await consent.authorizeReadAfterConsent($0) },
        isCurrentGrant: { consent.isCurrentGrant($0) }, permissionGeneration: { consent.choiceGeneration })
        if load { await model.load() }
        return Setup(fake: fake, auth: auth, model: model, store: store, api: api, changes: changes)
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
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
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

    @Test func grantingAfterARefusedReadAutomaticallyReadsTheWaitingMailExactlyOnce() async throws {
        let s = try await setup(.loaded(.denied))
        await s.model.mailActions.readWaiting()
        #expect(s.model.requestsReadingConsent)
        #expect(await s.api.receipts.isEmpty)
        #expect(await s.api.manualCalls == 0)
        #expect(await s.fake.rows("parcels").isEmpty)
        #expect(await s.model.chooseReadingConsent(true))
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(await s.api.receipts.count == 1)
        #expect(await s.api.manualCalls == 0)
        #expect(s.model.unread == .loaded(0))
        #expect(await s.fake.row("parcels", id: Rows.id(98_001))?["title"] == "架空の自動読取の本")
        await s.model.readingConsentChoiceSaved()
        await s.model.sceneBecameActive()
        #expect(await s.api.receipts.count == 1)
        #expect(await s.model.chooseReadingConsent(true))
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(await s.api.receipts.count == 1, "same server timestamp is already consumed")
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

    @Test func readingAndForegroundOfAnExistingGrantNeverStartsABacklogRead() async throws {
        let s = try await setup()
        await s.model.load()
        await s.model.sceneBecameActive()
        await s.model.readingConsentChoiceSaved()
        #expect(await s.api.receipts.isEmpty)
        #expect(await s.api.manualCalls == 0)
        #expect(await s.model.chooseReadingConsent(false))
        #expect(await s.api.receipts.isEmpty)
    }

    @Test func aFailedSaveCreatesNoAutomaticRead() async throws {
        let s = try await setup(.loaded(.notDetermined))
        await s.store.failSaving()
        #expect(!(await s.model.chooseReadingConsent(true)))
        #expect(await s.api.receipts.isEmpty)
        #expect(s.model.readingConsent.message == AIReadingConsentText.saveFailed)
        #expect(s.model.readingConsent.decision == .notDetermined)
    }

    @Test func aForegroundRefreshBetweenSavingAndTakingTheReceiptDoesNotDropIt() async throws {
        let s = try await setup(.loaded(.notDetermined))
        #expect(await s.model.readingConsent.choose(true))
        let gate = Gate()
        await s.store.holdNextLoad(gate)
        let refresh = Task { await s.model.sceneBecameActive() }
        #expect(await waitFor { await MainActor.run { s.model.readingConsent.isLoading } })
        await s.model.readingConsentChoiceSaved()
        #expect(await s.api.receipts.isEmpty)
        gate.open(); await refresh.value
        #expect(await waitFor { await s.api.receipts.count == 1 })
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(s.model.unread == .loaded(0))
    }

    @Test func aForegroundRefreshDuringTokenLookupWaitsAndThenStartsOnce() async throws {
        let token = Gate()
        let s = try await setup(.loaded(.notDetermined), tokenGate: token)
        #expect(await s.model.chooseReadingConsent(true))
        let refreshGate = Gate()
        await s.store.holdNextLoad(refreshGate)
        let refresh = Task { await s.model.sceneBecameActive() }
        #expect(await waitFor { await MainActor.run { s.model.readingConsent.isLoading } })
        token.open()
        #expect(await s.api.receipts.isEmpty)
        refreshGate.open(); await refresh.value
        #expect(await waitFor { await s.api.receipts.count == 1 })
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(s.model.unread == .loaded(0))
    }

    @Test(arguments: ["withdrawal", "another-user", "retired", "lookup-failed"])
    func aGrantInvalidatedBeforeSendingNeverStarts(_ cause: String) async throws {
        let token = Gate()
        let s = try await setup(.loaded(.notDetermined), tokenGate: token)
        #expect(await s.model.chooseReadingConsent(true))
        switch cause {
        case "withdrawal": #expect(await s.model.chooseReadingConsent(false))
        case "another-user": s.auth.session.follow(userID: Rows.id(123_456))
        case "retired": s.model.clearForSignOut()
        default:
            await s.store.replace(.failed)
            await s.model.sceneBecameActive()
        }
        token.open()
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(await s.api.receipts.isEmpty)
        #expect(await s.fake.rows("parcels").isEmpty)
    }

    @Test(arguments: [MailAPIFailure.unknownResult, .readFailed, .network])
    func automaticFailureKeepsPermissionAndRequiresAManualRetry(_ failure: MailAPIFailure) async throws {
        let s = try await setup(.loaded(.notDetermined))
        await s.api.answer(1, .init(failure: failure, partial: failure == .readFailed))
        #expect(await s.model.chooseReadingConsent(true))
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(s.model.readingConsent.decision == .allowed)
        #expect(await s.api.receipts.count == 1)
        await s.model.load()
        #expect(await s.api.receipts.count == 1)
        await s.model.mailActions.readWaiting()
        #expect(await s.api.manualCalls == 1)
        #expect(await s.api.receipts.count == 1)
        #expect(s.model.unread == .loaded(0))
        #expect(await s.fake.row("parcels", id: Rows.id(98_001)) != nil)
    }

    @Test(arguments: [MailAPIFailure.aiConsentRequired, .unavailable])
    func aLateOldGrantFailureCannotReopenOrOverwriteANewerGrant(_ failure: MailAPIFailure) async throws {
        let s = try await setup(.loaded(.notDetermined))
        let gate = Gate()
        await s.api.hold(1, on: gate)
        await s.api.answer(1, .init(failure: failure))
        #expect(await s.model.chooseReadingConsent(true))
        #expect(await waitFor { await s.api.receipts.count == 1 })
        #expect(await s.model.chooseReadingConsent(false))
        #expect(await s.model.chooseReadingConsent(true))
        gate.open()
        #expect(await waitFor { await s.api.receipts.count == 2 })
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(!s.model.requestsReadingConsent)
        #expect(s.model.mailActions.automaticReadNote == nil)
        #expect(s.model.unread == .loaded(0))
        let receipts = await s.api.receipts
        try #require(receipts.count == 2)
        #expect(receipts[0].decidedAt != receipts[1].decidedAt)
    }

    @Test func aLateAutomaticResultAfterSignOutDoesNotAnnounceReloadOrRestoreNotes() async throws {
        let s = try await setup(.loaded(.notDetermined))
        let gate = Gate()
        await s.api.hold(1, on: gate)
        await s.api.answer(1, .init(failure: .readFailed, partial: true))
        #expect(await s.model.chooseReadingConsent(true))
        #expect(await waitFor { await s.api.receipts.count == 1 })
        let reloads = s.changes.reloads, announced = s.changes.announcements
        s.model.clearForSignOut()
        gate.open()
        #expect(await waitFor { await s.fake.row("parcels", id: Rows.id(98_001)) != nil })
        #expect(s.changes.reloads == reloads)
        #expect(s.changes.announcements == announced)
        #expect(s.model.mailActions.readNote == nil)
        #expect(s.model.mailActions.automaticReadNote == nil)
        #expect(!s.model.requestsReadingConsent)
        #expect(s.model.unread == nil)
    }

    @Test(arguments: [MailAPIFailure.aiConsentRequired, .unavailable])
    func aNewGrantQueuedBehindAnOldManualReadWaitsForItsRefresh(_ failure: MailAPIFailure) async throws {
        let s = try await setup()
        let manualGate = Gate(), refreshGate = Gate()
        await s.api.holdManual(manualGate)
        await s.api.answerManual(.init(failure: failure))
        let manual = Task { await s.model.mailActions.readWaiting() }
        #expect(await waitFor { await s.api.manualCalls == 1 })
        #expect(await s.model.chooseReadingConsent(false))
        #expect(await s.model.chooseReadingConsent(true))
        await s.store.holdNextLoad(refreshGate)
        manualGate.open()
        #expect(await waitFor { await MainActor.run { s.model.readingConsent.isLoading } })
        #expect(await s.api.receipts.isEmpty)
        #expect(!s.model.requestsReadingConsent)
        refreshGate.open(); await manual.value
        #expect(await waitFor { await s.api.receipts.count == 1 })
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(!s.model.requestsReadingConsent)
        #expect(s.model.mailActions.automaticReadNote == nil)
        #expect(s.model.unread == .loaded(0))
    }

    @Test func aMissingTokenAfterWithdrawalDoesNotRestoreAnOldSignedOutNote() async throws {
        let gate = Gate()
        let s = try await setup(.loaded(.notDetermined), tokenGate: gate, tokenAvailable: false)
        #expect(await s.model.chooseReadingConsent(true))
        #expect(await s.model.chooseReadingConsent(false))
        gate.open()
        #expect(await waitFor { await MainActor.run { !s.model.mailActions.isReading } })
        #expect(await s.api.receipts.isEmpty)
        #expect(s.model.mailActions.readNote == nil)
        #expect(s.model.mailActions.automaticReadNote == nil)
    }
}
