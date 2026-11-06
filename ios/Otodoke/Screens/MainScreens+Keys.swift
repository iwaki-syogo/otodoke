// The opened key's parts for one sign-in (tasks 16, 17): kept apart from MainTabView.swift so the tabs'
// file only calls attachKeys(auth:).

import Foundation

extension MainScreens {
    /// The opened key's store (also AuthService.cleanup, for sign-out's steps), the one UnlockModel every
    /// detail uses and the settings switch, sharing one KeyVault and one KeyStorePolicy.
    func attachKeys(auth: AuthService) {
        let policy = KeyStorePolicy()
        let vault = KeyVault(keychain: SystemKeychain(), biometrics: SystemBiometrics(), policy: policy)
        let store = OpenKeyStore(session: auth.session, vault: vault)
        keys = store
        unlock = UnlockModel(store: store, keys: MailKeyReader(provider: auth.provider), vault: vault, policy: policy)
        faceID = FaceIDSwitch(policy: policy, vault: vault)
        settings.faceID = faceID
        auth.cleanup = store
    }
}
