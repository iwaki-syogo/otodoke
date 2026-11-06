// 「この端末で Face ID を使う」 under the passphrase card (task 19): shown with a key row in use on a device
// with Face ID or Touch ID. Off forbids keeping the key first, then deletes the device's item (CX3,
// FaceIDSwitch). Its two lines are FaceIDText's switch and explanation.

import SwiftUI

struct FaceIDToggleRow: View {
    let model: SettingsModel

    var body: some View {
        if model.showsFaceIDToggle, let faceID = model.faceID, let kind = faceID.biometry {
            Toggle(isOn: Binding(get: { faceID.isOn }, set: { faceID.set($0) })) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(FaceIDText.toggle(kind))
                        .font(.subheadline.weight(.medium))
                    Text(FaceIDText.usage(kind))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
        }
    }
}
