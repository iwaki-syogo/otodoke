// One mail in 「メールの履歴」, split by emails.body_state as src/app/app/parcels/[id]/page.tsx (2541793) does:
//  - plain (and null, as the Web's else branch): subject, "name <address>" or the address, and the
//    body (text_body trimmed, else htmlToText(html_body)), 「（本文なし）」 when there is none;
//  - sealed: 「🔒 暗号化されたメール」 and from_domain (M1: pressing it opens the Web's parcel page);
//  - dropped: 「本文は保存していません」, from_domain, and inside 「元メールを見る」 the Web's sentence;
//  - any other value: not opened, 「開けませんでした」 (a state this version does not know is never read
//    as plain).
// Sealed and dropped mails have subject, from_*, text_body and html_body null: never 「（本文なし）」.

import Foundation

enum MailBodyState: Equatable, Sendable {
    case plain
    case sealed
    case dropped
    /// A value this version does not know, kept as it came.
    case unknown(String)

    /// nil is plain (the Web's else branch). Compared exactly, as `===`.
    init(raw: String?) {
        guard let raw else {
            self = .plain
            return
        }
        if JSText.equal(raw, "plain") {
            self = .plain
        } else if JSText.equal(raw, "sealed") {
            self = .sealed
        } else if JSText.equal(raw, "dropped") {
            self = .dropped
        } else {
            self = .unknown(raw)
        }
    }
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
    static let sealedHeadline = "🔒 暗号化されたメール"
    static let droppedHeadline = "本文は保存していません"
    /// page.tsx, word for word.
    static let droppedDetail = "合言葉を決める前に届いたメールです。件名・差出人・本文は保存していません。"
    static let unopenable = "開けませんでした"
    static let noBody = "（本文なし）"

    static func display(_ email: EmailSummary) -> MailDisplay {
        switch MailBodyState(raw: email.bodyState) {
        case .plain:
            let from: String? = {
                if let name = truthy(email.fromName) { return "\(name) <\(email.fromAddress ?? "")>" }
                return email.fromAddress
            }()
            let body = plainBody(email)
            return MailDisplay(kind: .plain, subject: email.subject, fromText: from, fromDomain: nil, headline: nil, detail: body.isEmpty ? noBody : body)
        case .sealed:
            return MailDisplay(kind: .sealed, subject: nil, fromText: nil, fromDomain: truthy(email.fromDomain), headline: sealedHeadline, detail: nil)
        case .dropped:
            return MailDisplay(kind: .dropped, subject: nil, fromText: nil, fromDomain: truthy(email.fromDomain), headline: droppedHeadline, detail: droppedDetail)
        case .unknown:
            return MailDisplay(kind: .unopenable, subject: nil, fromText: nil, fromDomain: nil, headline: unopenable, detail: nil)
        }
    }

    /// `email.text_body?.trim() || (email.html_body ? htmlToText(email.html_body) : "")`.
    static func plainBody(_ email: EmailSummary) -> String {
        let text = JSText.trim(email.textBody ?? "")
        return !text.isEmpty ? text : (truthy(email.htmlBody).map(HtmlText.htmlToText) ?? "")
    }

    /// The value when JavaScript would call it true (not null, not "").
    private static func truthy(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
