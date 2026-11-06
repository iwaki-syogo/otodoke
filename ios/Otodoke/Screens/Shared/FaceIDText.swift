// TDD-STUB(task 18, task 19): the four lines about Face ID, the only words the app adds to the Web's
// (the field, the switch, the explanation, when it cannot be kept). Each follows the device: Face ID or
// Touch ID, never both. usageDescription is NSFaceIDUsageDescription in project.yml, word for word (a vitest
// compares them) and is usage(.faceID).
// Names and signatures are the contract with FaceIDSettingsTests; the wording is the implementer's.

import Foundation

enum FaceIDText {
    /// NSFaceIDUsageDescription.
    static let usageDescription = "メールを開く鍵を Face ID で守って、この端末だけに保存します。"

    /// The passphrase field (nil: the device has no biometrics, say neither).
    static func passphraseField(_ kind: BiometryKind?) -> String {
        "" // TDD-STUB(task 18)
    }

    /// The settings switch.
    static func toggle(_ kind: BiometryKind) -> String {
        "" // TDD-STUB(task 19)
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
        "" // TDD-STUB(task 18)
    }
}
