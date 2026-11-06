// TDD-STUB(task 10) — agreed API, placeholder bodies. Remove this marker once written.
// Port of src/lib/forwarding.ts and the choice of settings/page.tsx (2541793):
//   forwardingConfirmUrl(forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(text_body ?? html_body ?? "")

import Foundation

enum Forwarding {
    /// isForwardingConfirmation: from forwarding-noreply@google.com (trimmed, lowercased).
    static func isForwardingConfirmation(_ from: String) -> Bool { false }

    /// forwardingConfirmUrl: the first https URL in the text whose host is mail-settings.google.com
    /// and whose path starts with /mail/ (the WHATWG URL parser's hostname and pathname); nil when none.
    static func forwardingConfirmUrl(_ body: String) -> String? { nil }

    /// The approval link the settings screen shows: the stored value first, then the body, both
    /// through forwardingConfirmUrl.
    static func confirmURL(stored: String?, textBody: String?, htmlBody: String?) -> String? { nil }
}
