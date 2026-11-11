import Foundation
import Testing
@testable import Otodoke

/// B6: only a confirmed user-owned category may be treated as a completed choice.
@Suite("Category save confirmation (B6)")
@MainActor
struct CategorySaveConfirmationTests {
    private static let id = Rows.id(1)
    private static let later = "2026-11-05T00:00:00.000001+00:00"

    private struct Setup: Sendable {
        let fake: FakeSupabase
        let spend: SpendModel
        let detail: ParcelDetailModel
    }

    private func setup(source: String = "auto", second: Bool = false) async throws -> Setup {
        let fake = FakeSupabase.make()
        var rows = [Rows.parcel(1, ["ordered_at": "2026-11-03", "total_amount": 1000,
                                   "category": "food", "category_source": .string(source)])]
        if second {
            rows.append(Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 2000,
                                        "category": "food", "category_source": "auto"]))
        }
        await fake.insert("parcels", rows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        let reader = ParcelReader(provider: provider), writer = ParcelWriter(provider: provider, changes: changes)
        let spend = SpendModel(reader: reader, writer: writer, changes: changes, today: { "2026-11-04" })
        let detail = ParcelDetailModel(id: Self.id, reader: reader, writer: writer, today: { "2026-11-04" })
        await spend.load()
        await detail.load()
        return Setup(fake: fake, spend: spend, detail: detail)
    }

    private func spendRow(_ model: SpendModel, id: String = Self.id) -> ParcelRow? {
        model.parcels?.value?.first { $0.id == id }
    }

    private func changeBeforePatch(_ fake: FakeSupabase, category: String, source: String) async {
        let localID = Self.id, localLater = Self.later
        await fake.before("PATCH", "parcels") { tables in
            guard let index = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(localID) }) else { return }
            tables["parcels"]?[index]["category"] = .string(category)
            tables["parcels"]?[index]["category_source"] = .string(source)
            tables["parcels"]?[index]["updated_at"] = .string(localLater)
        }
    }

    @Test func spendConflictWithAnotherCategoryKeepsAFailureForTheOpenSheet() async throws {
        let s = try await setup()
        await changeBeforePatch(s.fake, category: "beauty", source: "user")
        let reads = await s.fake.count("GET", "parcels")
        await s.spend.setCategory(parcelID: Self.id, to: .hobby)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(await s.fake.count("GET", "parcels") > reads)
        #expect(spendRow(s.spend)?.category == "beauty")
        #expect(s.spend.categoryErrors[Self.id] != nil)
        #expect(s.spend.savingCategory.isEmpty)
        #expect(await s.fake.row("parcels", id: Self.id)?["category"] == "beauty")
    }

    @Test func spendUnknownUnappliedSameAutomaticValueIsNotAConfirmedChoice() async throws {
        let s = try await setup()
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await s.spend.setCategory(parcelID: Self.id, to: .food)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(spendRow(s.spend)?.category == "food")
        #expect(spendRow(s.spend)?.categorySource == "auto")
        #expect(s.spend.categoryErrors[Self.id] != nil)
    }

    @Test func spendUnknownConflictWithTheChosenAutomaticValueKeepsTheFailure() async throws {
        let s = try await setup()
        await changeBeforePatch(s.fake, category: "hobby", source: "auto")
        // The stale conditional PATCH changes no row; its lost answer must still be checked.
        await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await s.spend.setCategory(parcelID: Self.id, to: .hobby)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(spendRow(s.spend)?.category == "hobby")
        #expect(spendRow(s.spend)?.categorySource == "auto")
        #expect(s.spend.categoryErrors[Self.id] != nil)
    }

    @Test(arguments: ["conflict", "unknown"])
    func spendARecoveryReadFailureCannotCountAsACompletedChoice(_ cause: String) async throws {
        let s = try await setup()
        let reads = await s.fake.count("GET", "parcels")
        if cause == "conflict" {
            await changeBeforePatch(s.fake, category: "beauty", source: "user")
        } else {
            await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        }
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        await s.spend.setCategory(parcelID: Self.id, to: .hobby)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(s.spend.parcels == .failed)
        #expect(s.spend.categoryErrors[Self.id] != nil)
        #expect(await s.fake.row("parcels", id: Self.id)?["category"] == (cause == "conflict" ? "beauty" : "hobby"))
    }

    @Test func detailUnknownUnappliedSameAutomaticValueDoesNotCloseTheSheet() async throws {
        let s = try await setup()
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        let saved = await s.detail.setCategory(.food)
        #expect(!saved)
        #expect(s.detail.categoryError != nil)
        #expect(s.detail.shownCategory == .food)
        #expect(s.detail.row?.categorySource == "auto")
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test func detailUnknownConflictingAutomaticValueIsNotTheUsersChoice() async throws {
        let s = try await setup()
        await changeBeforePatch(s.fake, category: "hobby", source: "auto")
        await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        #expect(!(await s.detail.setCategory(.hobby)))
        #expect(s.detail.categoryError != nil)
        #expect(s.detail.shownCategory == .hobby)
        #expect(s.detail.row?.categorySource == "auto")
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test func detailARecoveryReadFailureKeepsTheChoiceUnconfirmed() async throws {
        let s = try await setup()
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        #expect(!(await s.detail.setCategory(.hobby)))
        #expect(s.detail.isUnconfirmed)
        #expect(s.detail.categoryError == ParcelDetailModel.unconfirmed)
        #expect(await s.fake.row("parcels", id: Self.id)?["category"] == "hobby")
        #expect(await s.fake.row("parcels", id: Self.id)?["category_source"] == "user")
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test(arguments: ["auto", "model"])
    func detailRecoveryOnlyMatchingAutomaticValueKeepsAnUnsavedNotice(_ source: String) async throws {
        let s = try await setup(source: source)
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        #expect(!(await s.detail.setCategory(.food)))
        #expect(s.detail.isUnconfirmed)
        #expect(s.detail.categoryError == ParcelDetailModel.unconfirmed)

        // This press only confirms the lost choice; a matching automatic value is still not saved by the user.
        #expect(!(await s.detail.setCategory(.food)))
        #expect(!s.detail.isUnconfirmed)
        #expect(s.detail.shownCategory == .food)
        #expect(s.detail.row?.categorySource == source)
        #expect(s.detail.categoryError == ParcelDetailModel.categoryNotSaved)
        #expect(await s.fake.count("PATCH", "parcels") == 1)

        #expect(await s.detail.setCategory(.food))
        #expect(s.detail.categoryError == nil)
        #expect(s.detail.row?.categorySource == "user")
        #expect(await s.fake.count("PATCH", "parcels") == 2)
    }

    @Test func detailRecoveryOnlyMissingRowReportsNotFoundWithoutResending() async throws {
        let s = try await setup()
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        #expect(!(await s.detail.setCategory(.food)))
        #expect(s.detail.isUnconfirmed)
        let localID = Self.id
        await s.fake.mutate { tables in
            tables["parcels"]?.removeAll { $0["id"] == .string(localID) }
        }

        #expect(!(await s.detail.setCategory(.food)))
        #expect(!s.detail.isUnconfirmed)
        #expect(s.detail.row == nil)
        #expect(s.detail.categoryError == ParcelDetailModel.categoryNotFound)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test func detailRecoveryOnlyMatchingUserValueRemainsAReadOnlyPositiveControl() async throws {
        let s = try await setup(source: "user")
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        #expect(!(await s.detail.setCategory(.food)))
        #expect(s.detail.isUnconfirmed)

        #expect(!(await s.detail.setCategory(.food)))
        #expect(!s.detail.isUnconfirmed)
        #expect(s.detail.shownCategory == .food)
        #expect(s.detail.row?.categorySource == "user")
        #expect(s.detail.categoryError == nil)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test(arguments: ["spend", "detail"])
    func aSuccessfulUserSaveIsACompletedChoice(_ screen: String) async throws {
        let s = try await setup()
        if screen == "spend" {
            await s.spend.setCategory(parcelID: Self.id, to: .hobby)
            #expect(s.spend.categoryErrors[Self.id] == nil)
            #expect(spendRow(s.spend)?.categorySource == "user")
        } else {
            #expect(await s.detail.setCategory(.hobby))
            #expect(s.detail.categoryError == nil)
            #expect(s.detail.row?.categorySource == "user")
        }
        #expect(await s.fake.row("parcels", id: Self.id)?["category"] == "hobby")
        #expect(await s.fake.row("parcels", id: Self.id)?["category_source"] == "user")
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test(arguments: ["spend", "detail"])
    func anAppliedWriteWithALostReplyClosesOnlyAfterConfirmingItsUserSource(_ screen: String) async throws {
        let s = try await setup()
        await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        if screen == "spend" {
            await s.spend.setCategory(parcelID: Self.id, to: .hobby)
            #expect(s.spend.categoryErrors[Self.id] == nil)
            #expect(spendRow(s.spend)?.category == "hobby")
            #expect(spendRow(s.spend)?.categorySource == "user")
        } else {
            #expect(await s.detail.setCategory(.hobby))
            #expect(s.detail.categoryError == nil)
            #expect(s.detail.row?.categorySource == "user")
        }
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test func anUnknownMatchingUserValueIsAValidPositiveControl() async throws {
        let s = try await setup(source: "user")
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        #expect(await s.detail.setCategory(.food))
        #expect(s.detail.categoryError == nil)
        #expect(s.detail.row?.categorySource == "user")
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test func aSuccessfulChoiceMayLeaveTheCurrentCategoryFilter() async throws {
        let s = try await setup()
        await s.spend.toggleCategory(.food)
        #expect(s.spend.orders.map(\.id).contains(Self.id))
        await s.spend.setCategory(parcelID: Self.id, to: .hobby)
        #expect(s.spend.category == .only(.food))
        #expect(!s.spend.orders.map(\.id).contains(Self.id))
        #expect(spendRow(s.spend)?.category == "hobby")
        #expect(spendRow(s.spend)?.categorySource == "user")
        #expect(s.spend.categoryErrors[Self.id] == nil)
    }

    @Test func aConflictMayLeaveTheFilterButMustKeepTheFailure() async throws {
        let s = try await setup()
        await s.spend.toggleCategory(.food)
        await changeBeforePatch(s.fake, category: "beauty", source: "user")
        await s.spend.setCategory(parcelID: Self.id, to: .hobby)
        #expect(s.spend.category == .only(.food))
        #expect(!s.spend.orders.map(\.id).contains(Self.id))
        #expect(spendRow(s.spend)?.category == "beauty")
        #expect(s.spend.categoryErrors[Self.id] != nil)
    }

    @Test func deferredVerificationDoesNotLoseTheOtherParcelsFailure() async throws {
        let s = try await setup(second: true)
        let firstGate = Gate()
        await s.fake.fail("PATCH", "parcels", with: .hold(firstGate))
        await s.fake.fail("PATCH", "parcels", nth: 2, with: .transport(.timedOut))
        let first = Task { await s.spend.setCategory(parcelID: Self.id, to: .hobby) }
        #expect(await waitFor { await s.fake.count("PATCH", "parcels") == 1 })
        let second = Task { await s.spend.setCategory(parcelID: Rows.id(2), to: .beauty) }
        #expect(await waitFor { await s.fake.count("PATCH", "parcels") == 2 })
        firstGate.open()
        #expect(await first.value)
        #expect(!(await second.value))
        #expect(s.spend.savingCategory.isEmpty)
        #expect(s.spend.pendingMove == nil)
        #expect(spendRow(s.spend)?.category == "hobby")
        #expect(spendRow(s.spend, id: Rows.id(2))?.category == "food")
        #expect(s.spend.categoryErrors[Self.id] == nil)
        #expect(s.spend.categoryErrors[Rows.id(2)] != nil)
        #expect(await s.fake.count("PATCH", "parcels") == 2)
    }

    @Test func aMoveWaitingForASuccessfulSaveStillCommitsAfterTheSave() async throws {
        let s = try await setup()
        let gate = Gate()
        await s.fake.fail("PATCH", "parcels", with: .hold(gate))
        let save = Task { await s.spend.setCategory(parcelID: Self.id, to: .hobby) }
        #expect(await waitFor { await s.fake.count("PATCH", "parcels") == 1 })
        await s.spend.showAll()
        #expect(s.spend.pendingMove == .period(.all))
        gate.open(); #expect(await save.value)
        #expect(s.spend.period == .all)
        #expect(s.spend.pendingMove == nil)
        #expect(spendRow(s.spend)?.categorySource == "user")
        #expect(s.spend.categoryErrors[Self.id] == nil)
    }

    @Test func signOutDuringCategoryVerificationCannotRestoreLoadedState() async throws {
        let s = try await setup()
        s.spend.openCategoryEditor(try #require(spendRow(s.spend)))
        let gate = Gate()
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let save = Task { await s.spend.setCategory(parcelID: Self.id, to: .hobby) }
        #expect(await waitFor { await s.fake.count("GET", "parcels") == reads + 1 })
        s.spend.clearForSignOut()
        gate.open(); await save.value
        #expect(s.spend.parcels == nil)
        #expect(s.spend.categoryErrors.isEmpty)
        #expect(s.spend.savingCategory.isEmpty)
        #expect(s.spend.pendingMove == nil)
        #expect(s.spend.categoryEditorID == nil)
        #expect(s.spend.editorCategory(for: Self.id) == nil)
        #expect(s.spend.categoryPicks.isEmpty)
    }

    @Test(arguments: ["success", "conflict", "unknown-auto", "read-failed"])
    func spendReturnsSuccessOnlyForAConfirmedUserChoice(_ cause: String) async throws {
        let s = try await setup()
        let reads = await s.fake.count("GET", "parcels")
        switch cause {
        case "conflict": await changeBeforePatch(s.fake, category: "beauty", source: "user")
        case "unknown-auto": await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        case "read-failed":
            await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
            await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        default: break
        }
        let saved = await s.spend.setCategory(parcelID: Self.id, to: .hobby)
        #expect(saved == (cause == "success"))
        #expect(await s.fake.count("PATCH", "parcels") == 1)
    }

    @Test(arguments: [false, true])
    func spendARecoveryOnlyChoiceNeverResendsTheUnconfirmedPatch(_ applied: Bool) async throws {
        let s = try await setup()
        s.spend.openCategoryEditor(try #require(spendRow(s.spend)))
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: applied ? .applyThenDrop(.timedOut) : .transport(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        #expect(!(await s.spend.setCategory(parcelID: Self.id, to: .hobby)))
        #expect(s.spend.parcels == .failed)
        #expect(s.spend.categoryErrors[Self.id] == SpendModel.categoryUnconfirmed)
        #expect(s.spend.categoryEditorID == Self.id)
        #expect(await s.fake.count("PATCH", "parcels") == 1)

        #expect(!(await s.spend.setCategory(parcelID: Self.id, to: .hobby)))
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(s.spend.editorCategory(for: Self.id) == (applied ? .hobby : .food))
        #expect(s.spend.categoryErrors[Self.id] == (applied ? nil : SpendModel.categoryNotSaved))
        #expect(s.spend.categoryEditorID == Self.id)
        #expect(await s.spend.setCategory(parcelID: Self.id, to: .hobby))
        #expect(await s.fake.count("PATCH", "parcels") == 2)
        #expect(await s.fake.row("parcels", id: Self.id)?["category_source"] == "user")
    }

    @Test func spendKeepsTheSameChoiceBusyUntilItsVerificationCompletes() async throws {
        let s = try await setup()
        s.spend.openCategoryEditor(try #require(spendRow(s.spend)))
        let gate = Gate(), reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let save = Task { await s.spend.setCategory(parcelID: Self.id, to: .hobby) }
        #expect(await waitFor { await s.fake.count("GET", "parcels") == reads + 1 })
        #expect(s.spend.savingCategory.contains(Self.id))
        #expect(!(await s.spend.setCategory(parcelID: Self.id, to: .daily)))
        s.spend.closeCategoryEditor()
        #expect(s.spend.categoryEditorID == Self.id)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        gate.open()
        #expect(!(await save.value))
        #expect(s.spend.savingCategory.isEmpty)
        #expect(s.spend.categoryErrors[Self.id] == SpendModel.categoryNotSaved)
    }
}
