// The settings screen's reads (src/app/app/settings/page.tsx, 2541793), each with user_id = me besides
// RLS, each failing on its own: a failure is .failed, never 0 or an empty list.

import Foundation
import PostgREST

/// user_keys: the key in use (activated_at not null, retired_at null).
struct UserKeyRow: Decodable, Equatable, Sendable {
    let keyId: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case keyId = "key_id"
        case createdAt = "created_at"
    }
}

/// A mail with classification = forwarding_confirmation (the newest few are read: CONFIRMATION_LOOKBACK).
struct ForwardingConfirmationRow: Decodable, Equatable, Sendable {
    let forwardingConfirmUrl: String?
    let textBody: String?
    let htmlBody: String?
    /// The clock the after-check uses (the Web's readConfirmUrl `at`).
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case forwardingConfirmUrl = "forwarding_confirm_url"
        case textBody = "text_body"
        case htmlBody = "html_body"
        case createdAt = "created_at"
    }
}

/// screen_events with decision = dropped.
struct DroppedMailRow: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let subject: String?
    let fromDomain: String?
    let createdAt: String
    let flaggedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, subject
        case fromDomain = "from_domain"
        case createdAt = "created_at"
        case flaggedAt = "flagged_at"
    }
}

struct SettingsReader: Sendable {
    /// Rows per request (PostgREST's cap).
    static let pageSize = 1000
    /// CONFIRMATION_LOOKBACK of src/app/app/settings/settings-reads.ts: how many confirmation mails are looked
    /// through (a look-alike without Google's link must not hide the real one).
    static let confirmationLookback = 10
    /// SAMPLE_PROVIDER_ID of src/lib/mail-keys.ts: the public sample mails.
    static let sampleProviderID = "demo:%"

    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// .loaded(nil) when there is no key in use; more than one row is .failed (maybeSingle).
    func currentKey() async -> LoadResult<UserKeyRow?> {
        guard let me = await provider.currentUserID() else { return .failed }
        let request = provider.database.from("user_keys").select("key_id, created_at")
            .eq("user_id", value: me)
            .not("activated_at", operator: .is, value: "null")
            // .is(_, value: nil) would send "is.NULL"; the Web's .is("retired_at", null) sends "is.null".
            .filter("retired_at", operator: "is", value: "null")
            .limit(2)
        guard let rows: [UserKeyRow] = await Self.decoded(request), rows.count <= 1 else { return .failed }
        return .loaded(rows.first)
    }

    /// countPlainRead: processed plain mails minus the samples (provider_email_id like "demo:%").
    func plainCount() async -> LoadResult<Int> {
        guard let me = await provider.currentUserID() else { return .failed }
        func query() -> PostgrestFilterBuilder {
            provider.database.from("emails").select("id", head: true, count: .exact)
                .eq("user_id", value: me)
                .eq("processing_status", value: "processed")
                .eq("body_state", value: "plain")
        }
        guard case let .loaded(all) = await Self.count(query()),
              case let .loaded(samples) = await Self.count(query().like("provider_email_id", pattern: Self.sampleProviderID))
        else { return .failed }
        return .loaded(all - samples)
    }

    /// Sealed mails whose body_envelope->>kid is not `currentKeyID`.
    func oldKeyCount(currentKeyID: String) async -> LoadResult<Int> {
        guard let me = await provider.currentUserID() else { return .failed }
        return await Self.count(
            provider.database.from("emails").select("id", head: true, count: .exact)
                .eq("user_id", value: me)
                .eq("body_state", value: "sealed")
                .neq("body_envelope->>kid", value: currentKeyID)
        )
    }

    /// The newest confirmation mails (the Web's readConfirmUrl): created_at ↓ (a row without it last, so it can
    /// never win), at most `confirmationLookback`. The caller takes the first whose link is Google's own
    /// (SettingsModel.pickApproval); the newest mail alone is not enough.
    func forwardingConfirmations() async -> LoadResult<[ForwardingConfirmationRow]> {
        guard let me = await provider.currentUserID() else { return .failed }
        let request = provider.database.from("emails").select("forwarding_confirm_url, text_body, html_body, created_at")
            .eq("user_id", value: me)
            .eq("classification", value: "forwarding_confirmation")
            .order("created_at", ascending: false, nullsFirst: false)
            .limit(Self.confirmationLookback)
        guard let rows: [ForwardingConfirmationRow] = await Self.decoded(request) else { return .failed }
        return .loaded(rows)
    }

    /// countArrivedAfter: the ordinary mails (not samples, not confirmations) and screen_events rows that arrived
    /// after `at` (a created_at). Any failed read fails the whole count.
    func arrivedAfter(_ at: String) async -> LoadResult<Int> {
        guard let me = await provider.currentUserID() else { return .failed }
        func emails() -> PostgrestFilterBuilder {
            provider.database.from("emails").select("id", head: true, count: .exact)
                .eq("user_id", value: me)
                .gt("created_at", value: at)
        }
        guard case let .loaded(all) = await Self.count(emails()),
              case let .loaded(samples) = await Self.count(emails().like("provider_email_id", pattern: Self.sampleProviderID)),
              case let .loaded(confirmations) = await Self.count(emails().eq("classification", value: "forwarding_confirmation")),
              case let .loaded(screened) = await Self.count(
                  provider.database.from("screen_events").select("id", head: true, count: .exact)
                      .eq("user_id", value: me)
                      .gt("created_at", value: at)
              )
        else { return .failed }
        return .loaded(all - samples - confirmations + screened)
    }

    /// Count of emails with StatusRules.unreadFilter(now:).
    func unreadCount(now: Date) async -> LoadResult<Int> {
        guard let me = await provider.currentUserID() else { return .failed }
        return await Self.count(
            provider.database.from("emails").select("id", head: true, count: .exact)
                .eq("user_id", value: me)
                .or(StatusRules.unreadFilter(now: now))
        )
    }

    /// Every dropped screen_event, created_at ↓ (all pages). Read by id (keyset, 1,000 a page, as
    /// ParcelReader.allParcels), then put in the Web's order: created_at ↓, then id ↑ (readAll adds id
    /// as the last order). Any failed page fails the whole read.
    func dropped() async -> LoadResult<[DroppedMailRow]> {
        guard let me = await provider.currentUserID() else { return .failed }
        var rows: [DroppedMailRow] = []
        var after: String?
        while true {
            var query = provider.database.from("screen_events").select("id, subject, from_domain, created_at, flagged_at")
                .eq("user_id", value: me)
                .eq("decision", value: "dropped")
            if let after { query = query.gt("id", value: after) }
            let request = query.order("id", ascending: true).limit(Self.pageSize)
            guard let page: [DroppedMailRow] = await Self.decoded(request) else { return .failed }
            rows.append(contentsOf: page)
            guard page.count >= Self.pageSize, let last = page.last else { break }
            after = last.id
        }
        return .loaded(Self.newestFirst(rows))
    }

    /// created_at ↓; rows of the same instant keep their id ↑ order (the input's).
    static func newestFirst(_ rows: [DroppedMailRow]) -> [DroppedMailRow] {
        rows.enumerated().sorted { a, b in
            let x = Instant.micros(a.element.createdAt), y = Instant.micros(b.element.createdAt)
            if let x, let y, x != y { return x > y }
            if x == nil || y == nil, a.element.createdAt != b.element.createdAt {
                return JSText.less(b.element.createdAt, a.element.createdAt)
            }
            return a.offset < b.offset
        }.map(\.element)
    }

    // MARK: helpers

    /// The rows of a 2xx answer; nil for any failure (an error answer, no answer, a body that does not decode).
    private static func decoded<T: Decodable>(_ request: PostgrestBuilder) async -> T? {
        do {
            let response = try await request.execute()
            return try JSONDecoder().decode(T.self, from: response.data)
        } catch {
            return nil
        }
    }

    /// The exact count from Content-Range. A failed request or a missing count is .failed, never 0.
    private static func count(_ request: PostgrestBuilder) async -> LoadResult<Int> {
        guard let response = try? await request.execute(), let count = response.count else { return .failed }
        return .loaded(count)
    }
}
