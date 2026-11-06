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
    func attachKeys(auth: AuthService, parts: KeyParts? = nil) {
        let parts = parts ?? .system(provider: auth.provider)
        let policy = parts.policy
        let vault = KeyVault(keychain: parts.keychain, biometrics: parts.biometrics, policy: policy, service: parts.service)
        // CX2: the app in front or not, as known from before the sign-in.
        let store = OpenKeyStore(session: auth.session, vault: vault, front: auth.front)
        let reader = MailKeyReader(provider: auth.provider)
        keys = store
        // The password opens the key with the sign-in's PBKDF2 (one at a time, off the main thread).
        unlock = UnlockModel(store: store, keys: reader, vault: vault, policy: policy, deriver: LiveKeyDeriver(deriver: auth.deriver), signInEmail: { auth.signedInEmail ?? "" })
        faceID = FaceIDSwitch(policy: policy, vault: vault)
        settings.faceID = faceID
        auth.cleanup = store
        let provider = auth.provider
        let setup = KeySetup(
            store: store,
            keys: reader,
            pending: reader,
            api: parts.api,
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

    /// What the opened key's parts are made of: the system's Keychain and Face ID, the saved choice, and the Web's
    /// key endpoints (tests pass fakes through MainScreens.live(auth:keyParts:)).
    @MainActor
    struct KeyParts {
        let policy: KeyStorePolicy
        let keychain: any Keychain
        let biometrics: any Biometrics
        let service: String
        let api: any KeyAPI

        static func system(provider: SupabaseProvider) -> KeyParts {
            KeyParts(
                policy: KeyStorePolicy(),
                keychain: SystemKeychain(),
                biometrics: SystemBiometrics(),
                service: KeyVault.defaultService,
                api: KeyAPIClient(session: provider.urlSession)
            )
        }
    }

    /// The main screens of the signed-in generation now (B1-1): the ones AuthService keeps for it (made once by
    /// makeSignedIn); made here (and kept) when AuthService has no maker yet. A View made again gets the same
    /// screens, so the opened key's store, AuthService.cleanup and the key step stay one.
    static func of(_ auth: AuthService) -> MainScreens {
        let hadMaker = auth.makeSignedIn != nil
        if !hadMaker {
            auth.makeSignedIn = { MainScreens.live(auth: $0) }
        }
        if let screens = auth.signedInObject() as? MainScreens { return screens }
        // N-1: with a maker, the generation's own screens are the maker's alone (a View made while signing out
        // gets bare ones: no key store, AuthService.cleanup stays the generation's).
        return .live(auth: auth, withKeys: !hadMaker)
    }
}
