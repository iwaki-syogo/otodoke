// The words of 「荷物を登録」 (src/app/app/parcels/new/page.tsx, manual-form.tsx, src/lib/manual-parcel.ts,
// manual-actions.ts), word for word. A vitest (ios-manual-parcel.test.ts) compares them with the Web's.
// The screen holds no Japanese of its own.

enum ManualParcelText {
    // Page
    static let heading = "荷物を登録"
    static let close = "閉じる"

    // Labels
    static let titleLabel = "品名"
    static let shopLabel = "店"
    static let orderedAtLabel = "注文日"
    static let expectedDateLabel = "お届け予定日"
    static let amountLabel = "金額"
    static let amountUnit = "円"
    static let amountPlaceholder = "2480"
    static let categoryLabel = "分類"
    static let trackingLabel = "追跡番号"
    static let carrierLabel = "運送会社"
    static let presenceLabel = "受け取り"
    static let statusLabel = "状態"

    // Choices
    static let uncategorized = "未分類"
    static let carrierAuto = "自動判定"
    static let presenceNone = "指定なし"
    static let presenceFace = "対面"
    static let presenceDrop = "置き配・投函"
    static let statusOrdered = "注文済み"
    static let statusShipped = "発送済み"
    static let statusDelivered = "配達済み"
    static let statusReceived = "受け取り済み"

    // Edit (src/app/app/parcels/[id]/edit/page.tsx, [id]/page.tsx, manual-form.tsx, manual-actions.ts)
    static let editHeading = "荷物を編集"
    static let edit = "編集"
    static let save = "保存"
    static let deleteSummary = "この荷物を消す"
    static let deleteWarning = "消すと元に戻せません。"
    static let deleteConfirm = "本当に消す"
    static let deleteButton = "消す"
    static let deleting = "消しています…"
    static let notFound = "見つかりません"
    static let deleteFailed = "削除できませんでした"
    static let deleteUnchecked = "「本当に消す」にチェックを入れてください"

    // Not on the Web (its date field has a browser's own clear): the way to leave a date empty.
    static let dateClear = "消す"
    static let dateNone = "指定なし"

    // Buttons
    static let submit = "登録"
    static let submitting = "保存しています…"

    // Checks (ManualParcelSchema)
    static let titleEmpty = "品名を入れてください"
    static let titleTooLong = "品名が長すぎます"
    static let shopEmpty = "店を入れてください"
    static let shopTooLong = "店の名前が長すぎます"
    static let orderedAtInvalid = "注文日が正しくありません"
    static let expectedDateInvalid = "お届け予定日が正しくありません"
    static let amountInvalid = "金額が正しくありません"
    static let categoryInvalid = "分類が正しくありません"
    static let trackingTooLong = "追跡番号が長すぎます"
    static let checkInput = "入力を確かめてください"

    // Saving (manual-actions.ts)
    static let notSignedIn = "ログインしてください"
    static let failed = "保存できませんでした"
    /// The answer was lost: it is not sent again; the list is read again instead. (Not on the Web.)
    static let unknown = "保存できたか、確かめられませんでした。荷物の一覧を見て確かめてください。"

    /// The parcel changed between the read and the write (the updated_at the form was opened with no longer matches; the Web's CHANGED). The detail page's words.
    static let changed = "更新できませんでした。開き直してください"
    /// A delete whose answer was lost and whose parcel could not be read again. (Not on the Web.)
    static let deleteUnknown = "削除できたか、確かめられませんでした。荷物の一覧を見て確かめてください。"

    /// The label of a date's 「消す」 button, so VoiceOver says which date.
    static func dateClearLabel(_ field: String) -> String { field + "を消す" }

    static func statusName(_ status: ManualStatus) -> String {
        switch status {
        case .ordered: statusOrdered
        case .shipped: statusShipped
        case .delivered: statusDelivered
        case .received: statusReceived
        }
    }

    /// The status choices: the Web's four, and the one a mail set while the parcel is there (STATUS_LABEL's word).
    static func statusChoices(keeping current: String) -> [(value: String, name: String)] {
        var choices = ManualStatus.allCases.map { (value: $0.rawValue, name: statusName($0)) }
        if ManualParcel.carriedStatuses.contains(current) || current == ManualParcel.cancelled {
            choices.append((value: current, name: BadgeText.status(current)))
        }
        return choices
    }

    static func presenceName(_ presence: ManualPresence) -> String {
        switch presence {
        case .none: presenceNone
        case .face: presenceFace
        case .drop: presenceDrop
        }
    }

    static func carrierName(_ carrier: ManualCarrier) -> String {
        carrier.carrierName ?? carrierAuto
    }
}
