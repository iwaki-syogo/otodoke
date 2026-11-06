// The opened key's parts for one sign-in (tasks 16, 17, and the password login): kept apart from
// MainTabView.swift so the tabs' file only calls attachKeys(auth:). Made once per signed-in generation
// (MainScreens.of, AuthService.signedInObject), never by a View's init (B1-1).

import Foundation

extension MainScreens {
    /// The opened key's store (also AuthService.cleanup, for sign-out's steps), the one UnlockModel every
    /// detail uses, the settings switch and the key step after a password sign-in (KeySetup), sharing one
    /// KeyVault and one KeyStorePolicy. The unlock opens the key with the signed-in session's address. When the
    /// main screens come up right after a password sign-in, the key in use is opened (or the first one made)
    /// with that sign-in's master, which is zeroed afterwards.
    func attachKeys(auth: AuthService) {
        let policy = KeyStorePolicy()
        let vault = KeyVault(keychain: SystemKeychain(), biometrics: SystemBiometrics(), policy: policy)
        let store = OpenKeyStore(session: auth.session, vault: vault)
        let reader = MailKeyReader(provider: auth.provider)
        keys = store
        unlock = UnlockModel(store: store, keys: reader, vault: vault, policy: policy, signInEmail: { auth.signedInEmail ?? "" })
        faceID = FaceIDSwitch(policy: policy, vault: vault)
        settings.faceID = faceID
        auth.cleanup = store
        let provider = auth.provider
        let setup = KeySetup(
            store: store,
            keys: reader,
            pending: reader,
            api: KeyAPIClient(session: provider.urlSession),
            vault: vault,
            policy: policy,
            accessToken: { try? await provider.auth.session.accessToken }
        )
        keySetup = setup
        unlock?.keySetup = setup
        unlock?.signOut = { await auth.signOut() }
        settings.keySetup = setup
        // A3-1: the hand-off is taken now, and again whenever a sign-in of this generation decides one later
        // (whichever comes first, takeSignInSecret answers once: the key step runs once).
        let takeHandOff: @MainActor () -> Void = { [weak auth, weak setup] in
            guard let auth, let setup else { return }
            if let signIn = auth.takeSignInSecret() {
                Task {
                    await setup.run(signIn)
                    signIn.wipe()
                }
            } else if auth.takeAddressMismatch() {
                setup.noteAddressMismatch()
            }
        }
        auth.setKeyStep(takeHandOff)
        takeHandOff()
    }

    /// The main screens of the signed-in generation now (B1-1): the ones AuthService keeps for it (made once by
    /// makeSignedIn); made here (and kept) when AuthService has no maker yet. A View made again gets the same
    /// screens, so the opened key's store, AuthService.cleanup and the key step stay one.
    static func of(_ auth: AuthService) -> MainScreens {
        if auth.makeSignedIn == nil {
            auth.makeSignedIn = { MainScreens.live(auth: $0) }
        }
        if let screens = auth.signedInObject() as? MainScreens { return screens }
        return .live(auth: auth)
    }
}
