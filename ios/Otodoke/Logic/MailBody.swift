// TDD-STUB(task 3) — the names and signatures below are the agreed API; the bodies are placeholders
// for the implementer. Remove this marker line once the bodies are written.
//
// One mail in 「メールの履歴」, split by emails.body_state as src/app/app/parcels/[id]/page.tsx does:
//  - plain (and null, as the Web's else branch): subject, "name <address>" or the address, and the
//    body (text_body trimmed, else htmlToText(html_body)), 「（本文なし）」 when there is none;
//  - sealed: 「🔒 暗号化されたメール」 and from_domain (M1: pressing it opens the Web's parcel page);
//  - dropped: 「本文は保存していません」, from_domain, and inside 「元メールを見る」 the Web's sentence;
//  - any other value: not opened, 「開けませんでした」.
// Sealed and dropped mails have subject, from_*, text_body and html_body null: never 「（本文なし）」.

import Foundation

enum MailBodyState: Equatable, Sendable {
    case plain
    case sealed
    case dropped
    /// A value this version does not know, kept as it came.
    case unknown(String)

    /// nil is plain (the Web's else branch).
    init(raw: String?) { self = .plain }
}

struct MailDisplay: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case plain
        case sealed
        case dropped
        /// An unknown body_state: shown as 「開けませんでした」, nothing else.
        case unopenable
    }

    let kind: Kind
    /// plain only.
    let subject: String?
    /// plain only: "name <address>" or the address.
    let fromText: String?
    /// sealed and dropped only (when not empty).
    let fromDomain: String?
    /// The line under the label: sealed 「🔒 暗号化されたメール」, dropped 「本文は保存していません」,
    /// unopenable 「開けませんでした」; nil for plain (its subject is the line).
    let headline: String?
    /// Inside 「元メールを見る」: plain the body or 「（本文なし）」, dropped the Web's sentence; nil for
    /// sealed (opened on the Web in M1) and unopenable.
    let detail: String?
}

enum MailBody {
    static let sealedHeadline = ""
    static let droppedHeadline = ""
    static let droppedDetail = ""
    static let unopenable = ""
    static let noBody = ""

    static func display(_ email: EmailSummary) -> MailDisplay {
        MailDisplay(kind: .plain, subject: nil, fromText: nil, fromDomain: nil, headline: nil, detail: nil)
    }
}
