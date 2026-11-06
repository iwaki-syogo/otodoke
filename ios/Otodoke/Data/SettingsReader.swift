// TDD-STUB(task 10) — agreed API, placeholder bodies. Remove this marker once written.
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

/// The newest mail with classification = forwarding_confirmation.
struct ForwardingConfirmationRow: Decodable, Equatable, Sendable {
    let forwardingConfirmUrl: String?
    let textBody: String?
    let htmlBody: String?
    let sentAt: String?

    enum CodingKeys: String, CodingKey {
        case forwardingConfirmUrl = "forwarding_confirm_url"
        case textBody = "text_body"
        case htmlBody = "html_body"
        case sentAt = "sent_at"
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
    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// .loaded(nil) when there is no key in use; more than one row is .failed (maybeSingle).
    func currentKey() async -> LoadResult<UserKeyRow?> { .failed }

    /// countPlainRead: processed plain mails minus the samples (provider_email_id like "demo:%").
    func plainCount() async -> LoadResult<Int> { .failed }

    /// Sealed mails whose body_envelope->>kid is not `currentKeyID`.
    func oldKeyCount(currentKeyID: String) async -> LoadResult<Int> { .failed }

    /// forwarding_confirm_url, text_body, html_body, sent_at of the newest confirmation (sent_at ↓, 1).
    func forwardingConfirmation() async -> LoadResult<ForwardingConfirmationRow?> { .failed }

    /// Count of emails with StatusRules.unreadFilter(now:).
    func unreadCount(now: Date) async -> LoadResult<Int> { .failed }

    /// Every dropped screen_event, created_at ↓ (all pages).
    func dropped() async -> LoadResult<[DroppedMailRow]> { .failed }
}
