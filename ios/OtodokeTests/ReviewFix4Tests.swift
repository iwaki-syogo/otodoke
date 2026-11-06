import Foundation
import Testing
@testable import Otodoke

/// [Fix 4: NtH-C] After a conflict, the category read again counts as saved only when it is the one
/// chosen and the user's own. The same category set by the mail import is not the choice: a later
/// mail may still change it, so the user is asked to choose again.
@Suite("Review fix 4", .serialized)
@MainActor
struct ReviewFix4Tests {
    private func stored(_ fake: FakeSupabase, _ n: Int, _ column: String) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?[column]?.string
    }

    private func seededDetail() async throws -> (FakeSupabase, ParcelDetailModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "category": "food", "category_source": "auto"])])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        return (fake, model)
    }

    @Test func theSameCategoryFromTheMailImportIsNotTakenAsSaved() async throws {
        let (fake, model) = try await seededDetail()
        // Between opening and the tap, the mail import sets the same category the user then picks.
        await fake.touch("parcels", id: Rows.id(1), ["category": "hobby", "category_source": "auto"])
        #expect(await model.setCategory(.hobby) == false)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await stored(fake, 1, "category_source") == "auto")
        #expect(model.shownCategory == .hobby)
        #expect(model.categoryError == "保存されていませんでした。もう一度選んでください。")

        // Choosing again writes it on the version read now, as the user's.
        #expect(await model.setCategory(.hobby) == true)
        #expect(await stored(fake, 1, "category") == "hobby")
        #expect(await stored(fake, 1, "category_source") == "user")
        #expect(model.categoryError == nil)
    }

    @Test func theSameCategoryWithNoSourceIsNotTakenAsSaved() async throws {
        let (fake, model) = try await seededDetail()
        await fake.touch("parcels", id: Rows.id(1), ["category": "hobby", "category_source": nil])
        #expect(await model.setCategory(.hobby) == false)
        #expect(model.categoryError == "保存されていませんでした。もう一度選んでください。")
    }

    @Test func theSameCategoryAlreadyTheUsersIsTakenAsSaved() async throws {
        let (fake, model) = try await seededDetail()
        // The same choice already saved as the user's (e.g. from another device).
        await fake.touch("parcels", id: Rows.id(1), ["category": "hobby", "category_source": "user"])
        #expect(await model.setCategory(.hobby) == true)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.shownCategory == .hobby)
        #expect(model.categoryError == nil)
    }
}
