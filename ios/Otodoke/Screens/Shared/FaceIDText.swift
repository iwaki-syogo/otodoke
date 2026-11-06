// The four lines about Face ID, the only words the app adds to the Web's (the field, the switch, the
// explanation, when it cannot be kept). Each follows the device: Face ID or Touch ID, never both.
// usageDescription is NSFaceIDUsageDescription in project.yml, word for word (a vitest compares them) and is
// usage(.faceID).

import Foundation

enum FaceIDText {
    /// NSFaceIDUsageDescription.
    static let usageDescription = "メールを開く鍵を Face ID で守って、この端末だけに保存します。"

    /// The line over the passphrase field (nil: the device has no biometrics or keeping is turned off, so the
    /// key stays in memory only).
    static func passphraseField(_ kind: BiometryKind?) -> String {
        guard let kind else { return "合言葉で開きます。アプリを離れるまで覚えます。" }
        return "合言葉で開きます。次からは \(name(kind)) で開けます。"
    }

    /// The settings switch.
    static func toggle(_ kind: BiometryKind) -> String {
        "この端末で \(name(kind)) を使う"
    }

    /// What keeping the key with Face ID / Touch ID means.
    static func usage(_ kind: BiometryKind) -> String {
        switch kind {
        case .faceID: usageDescription
        case .touchID: usageDescription.replacingOccurrences(of: "Face ID", with: "Touch ID")
        }
    }

    /// The key could not be kept on this device (memory only until the app is closed or goes to the background).
    static func cannotSave(_ kind: BiometryKind?) -> String {
        guard let kind else { return "この端末には保存できませんでした。アプリを離れるまで覚えます。" }
        return "\(name(kind)) で保存できませんでした。アプリを離れるまで覚えます。"
    }

    private static func name(_ kind: BiometryKind) -> String {
        switch kind {
        case .faceID: "Face ID"
        case .touchID: "Touch ID"
        }
    }
}
