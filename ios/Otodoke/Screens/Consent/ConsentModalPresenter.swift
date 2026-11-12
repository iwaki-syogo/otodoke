import Observation
import SwiftUI
import UIKit

/// Presents above the current UIKit sheet without replacing its state or its SwiftUI binding.
/// The transparent full-screen host supplies the modal layer; the SwiftUI content draws the card.
struct ConsentModalPresenter<Content: View>: UIViewRepresentable {
    let isPresented: Bool
    @ViewBuilder let content: Content

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ConsentPresentationAnchor {
        let anchor = ConsentPresentationAnchor()
        anchor.isUserInteractionEnabled = false
        anchor.isAccessibilityElement = false
        context.coordinator.anchor = anchor
        anchor.windowChanged = { [weak coordinator = context.coordinator] in coordinator?.reconcile() }
        return anchor
    }

    func updateUIView(_ uiView: ConsentPresentationAnchor, context: Context) {
        context.coordinator.update(isPresented: isPresented, content: content)
    }

    static func dismantleUIView(_ uiView: ConsentPresentationAnchor, coordinator: Coordinator) {
        uiView.windowChanged = nil
        coordinator.stop()
    }

    @MainActor
    final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
        weak var anchor: ConsentPresentationAnchor?
        private var requested = false
        private var stopped = false
        private var scheduled = false
        private var starting = false
        private var dismissing = false
        private var content: Content?
        private var host: ConsentHostingController<ConsentPresentedContent<Content>>?
        private var presentationState: ConsentModalPresentationState?
        private var accessibilityMasks: [ConsentAccessibilityShield.Token] = []

        override init() {
            super.init()
            NotificationCenter.default.addObserver(self, selector: #selector(applicationBecameActive),
                                                   name: UIApplication.didBecomeActiveNotification, object: nil)
        }

        @objc private func applicationBecameActive() { reconcile() }

        func update(isPresented: Bool, content: Content) {
            requested = isPresented
            self.content = content
            if let presentationState { host?.rootView = ConsentPresentedContent(content: content, state: presentationState) }
            reconcile()
        }

        func stop() {
            stopped = true
            requested = false
            content = nil
            NotificationCenter.default.removeObserver(self)
            reconcile()
        }

        func reconcile() {
            if let host, !dismissing { reconcileHostAttachment(host) }
            guard requested, !stopped else { dismissHost(); return }
            guard host == nil, !starting, !dismissing, let window = anchor?.window,
                  let root = window.rootViewController, let content else { return }
            guard window.windowScene?.activationState == .foregroundActive else { return }
            var chain = [root]
            while let presented = chain.last?.presentedViewController { chain.append(presented) }
            guard let presenter = chain.last else { return }
            // A prior signed-in generation must finish removing its own host before this one presents.
            guard !chain.contains(where: { $0 is ConsentModalHosting }),
                  chain.allSatisfy({ !$0.isBeingPresented && !$0.isBeingDismissed && $0.transitionCoordinator == nil }),
                  presenter.viewIfLoaded?.window != nil else {
                scheduleReconciliation()
                return
            }

            starting = true
            defer { starting = false }
            // Commit the editor's field without dismissing its sheet; the keyboard must not cover the card.
            window.endEditing(true)
            guard requested, !stopped else { return }
            let state = ConsentModalPresentationState()
            let controller = ConsentHostingController(rootView: ConsentPresentedContent(content: content, state: state))
            controller.modalPresentationStyle = .overFullScreen
            controller.modalTransitionStyle = .crossDissolve
            controller.isModalInPresentation = true
            controller.loadViewIfNeeded()
            controller.view.backgroundColor = .clear
            controller.view.isOpaque = false
            controller.view.accessibilityViewIsModal = true
            controller.view.accessibilityElementsHidden = true
            controller.didDisappear = { [weak self, weak controller] in
                guard let controller else { return }
                self?.reconcileHostAttachment(controller)
            }
            presentationState = state
            host = controller
            // UIKit presents synchronously without a full-screen slide. A manual/category sheet stays underneath.
            presenter.present(controller, animated: false) { [self] in
                guard host === controller else { return }
                controller.presentationController?.delegate = self
                maskBackground(chain: chain, modalView: controller.view)
                controller.view.accessibilityElementsHidden = false
                // Focus is requested only after UIKit has attached the modal to its presentation window.
                if requested, !stopped { state.isPresented = true }
                reconcile()
            }
        }

        private func scheduleReconciliation() {
            guard !scheduled else { return }
            scheduled = true
            // Keep this coordinator alive until a pending dismissal can restore its accessibility masks.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [self] in
                scheduled = false
                reconcile()
            }
        }

        private func dismissHost() {
            guard let controller = host else { releaseAccessibilityMasks(); return }
            guard !dismissing else { return }
            var ownedChain: [UIViewController] = [controller]
            while let presented = ownedChain.last?.presentedViewController { ownedChain.append(presented) }
            guard ownedChain.allSatisfy({ !$0.isBeingPresented && !$0.isBeingDismissed && $0.transitionCoordinator == nil }) else {
                scheduleReconciliation()
                return
            }
            dismissing = true
            let finished = { [self] in finishHost(controller) }
            guard let presenter = controller.presentingViewController else { finished(); return }
            guard presenter.presentedViewController === controller else {
                dismissing = false
                scheduleReconciliation()
                return
            }
            // Target our host by identity. Dismissing from it could close only its privacy child.
            // Its presenting editor and all of that editor's input remain intact.
            presenter.dismiss(animated: false, completion: finished)
        }

        private func reconcileHostAttachment(_ controller: UIViewController) {
            guard host === controller, !dismissing, let root = anchor?.window?.rootViewController else { return }
            var chain = [root]
            while let presented = chain.last?.presentedViewController { chain.append(presented) }
            if chain.contains(where: { $0 === controller }) {
                if chain.contains(where: { $0.isBeingDismissed }) { scheduleReconciliation() }
                return
            }
            guard !controller.isBeingPresented, !controller.isBeingDismissed,
                  controller.transitionCoordinator == nil else { scheduleReconciliation(); return }
            // A presenting editor may finish its own save and close while this host is above it.
            // Observe that cascade rather than retaining a detached host forever. Privacy alone leaves it in the chain.
            controller.view.accessibilityElementsHidden = true
            finishHost(controller)
        }

        private func finishHost(_ controller: UIViewController) {
            guard host === controller else { return }
            host = nil
            presentationState = nil
            dismissing = false
            if requested, !stopped {
                // Keep the background shield across an external cascade and the replacement presentation.
                scheduleReconciliation()
            } else {
                releaseAccessibilityMasks()
            }
        }

        private func releaseAccessibilityMasks() {
            accessibilityMasks.forEach { ConsentAccessibilityShield.release($0) }
            accessibilityMasks.removeAll()
        }

        private func maskBackground(chain: [UIViewController], modalView: UIView) {
            accessibilityMasks.removeAll { token in
                guard let view = ConsentAccessibilityShield.view(for: token), modalView.isDescendant(of: view) else { return false }
                ConsentAccessibilityShield.release(token)
                return true
            }
            func mask(_ view: UIView) {
                guard view !== modalView else { return }
                if modalView.isDescendant(of: view) {
                    // Do not hide an ancestor of our own host if UIKit uses a shared container.
                    view.subviews.forEach(mask)
                } else {
                    if !accessibilityMasks.contains(where: { ConsentAccessibilityShield.owns($0, view: view) }) {
                        accessibilityMasks.append(ConsentAccessibilityShield.acquire(view))
                    }
                }
            }
            chain.compactMap { $0.viewIfLoaded }.forEach(mask)
        }

        func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool { false }
    }
}

final class ConsentPresentationAnchor: UIView {
    var windowChanged: (@MainActor () -> Void)?
    override func didMoveToWindow() {
        super.didMoveToWindow()
        windowChanged?()
    }
}

private protocol ConsentModalHosting: AnyObject {}

private final class ConsentHostingController<Content: View>: UIHostingController<Content>, ConsentModalHosting {
    var didDisappear: (@MainActor () -> Void)?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        DispatchQueue.main.async { [weak self] in self?.didDisappear?() }
    }
}

@MainActor
@Observable
private final class ConsentModalPresentationState {
    var isPresented = false
}

private struct ConsentPresentedContent<Content: View>: View {
    let content: Content
    let state: ConsentModalPresentationState

    var body: some View {
        content
            .environment(\.consentModalIsPresented, state.isPresented)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                Color.clear.ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {}
                    .accessibilityHidden(true)
            }
            .ignoresSafeArea(.keyboard)
    }
}

private struct ConsentModalPresentedKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// Standalone previews are already visible; a UIKit presenter sets this only after attachment.
    var consentModalIsPresented: Bool {
        get { self[ConsentModalPresentedKey.self] }
        set { self[ConsentModalPresentedKey.self] = newValue }
    }
}

/// Reference-counted masks allow sign-in generations to overlap during UIKit dismissal without
/// either unmasking a newer modal or leaving the app inaccessible after both have gone.
@MainActor
private enum ConsentAccessibilityShield {
    struct Token {
        let viewID: ObjectIdentifier
        let entryID: UUID
    }
    private final class Entry {
        weak var view: UIView?
        let id = UUID()
        let previous: Bool
        var count = 1
        init(_ view: UIView) {
            self.view = view
            previous = view.accessibilityElementsHidden
        }
    }
    private static var entries: [ObjectIdentifier: Entry] = [:]

    static func acquire(_ view: UIView) -> Token {
        let key = ObjectIdentifier(view)
        let entry: Entry
        if let existing = entries[key], existing.view === view {
            entry = existing
            entry.count += 1
        } else {
            entry = Entry(view)
            entries[key] = entry
        }
        view.accessibilityElementsHidden = true
        return Token(viewID: key, entryID: entry.id)
    }

    static func view(for token: Token) -> UIView? {
        guard let entry = entries[token.viewID], entry.id == token.entryID else { return nil }
        return entry.view
    }

    static func owns(_ token: Token, view: UIView) -> Bool {
        entries[token.viewID]?.id == token.entryID && entries[token.viewID]?.view === view
    }

    static func release(_ token: Token) {
        guard let entry = entries[token.viewID], entry.id == token.entryID else { return }
        entry.count -= 1
        guard entry.count == 0 else { return }
        entry.view?.accessibilityElementsHidden = entry.previous
        entries[token.viewID] = nil
    }
}
