import Foundation

/// Exact values of read-notices.ts, checked against the Web source rather than contract names.
enum StorageIntakeText {
    static let notice = "受け取れなかったメールがあります。"
    static let body = "このメールの本文は保存していません。"
    static let reason = "保管の枠を空けたあと、元メールをもう一度送ってください。"
    static let failed = "メールの受信状況を確認できませんでした。"
    static let confirm = "確認しました"
    static let confirming = "確認しています…"
}

/// Exact values of settings-mail-text.ts REMEMBERED_SENDER_TEXT.
enum RememberedSenderText {
    static let title = "覚えた差出人"
    static let remove = "外す"
    static let removing = "外しています…"
    static let removed = "外しました。"
    static let failed = "外せませんでした。もう一度お試しください。"
}
