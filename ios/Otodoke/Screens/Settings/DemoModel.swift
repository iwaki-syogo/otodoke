// The model of 「サンプルで試す」: loads the sample mails or clears everything through the Web's endpoints (DemoAPI).
// One action at a time: a press while one runs sends nothing (the check and the start are one step on the main
// actor). A request is never sent again; when the answer is not known (no connection, not the endpoint's JSON) the
// parcels are read again (a load moves to 荷物 as when it went through; no failure sentence). The model lives with the settings model, so a request
// goes on when the page is left.

import Foundation
import Observation

@MainActor
@Observable
final class DemoModel {
    enum Phase: Equatable, Sendable {
        case idle, loading, clearing
    }

    /// What the page says under the buttons.
    struct Notice: Equatable, Sendable {
        /// 「{N} 通は読み込めました。」
        var partial: String?
        /// The failure sentence (red).
        var error: String?
        /// 「…消しました。」
        var cleared: String?
    }

    private(set) var phase: Phase = .idle
    private(set) var notice = Notice()
    /// Moves on at each load that went through (the tabs move to 荷物 when it does).
    private(set) var loadedCount = 0
    /// Moves on at each clear-all that went through (the 荷物 tab closes what it has open).
    private(set) var clearedCount = 0
    /// The list's note for a busy load: shown on the 荷物 tab until it is closed.
    var showsBusyNote = false

    @ObservationIgnored private let api: any DemoAPI
    @ObservationIgnored private let accessToken: @MainActor () async -> String?
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    /// Tells the other tabs the parcels changed (DataChanges, through ParcelWriter.announceOutsideChange).
    @ObservationIgnored private let changed: @MainActor () -> Void

    init(api: any DemoAPI, isCurrent: @escaping @MainActor () -> Bool = { true }, accessToken: @escaping @MainActor () async -> String?, changed: @escaping @MainActor () -> Void) {
        self.api = api
        self.isCurrent = isCurrent
        self.accessToken = accessToken
        self.changed = changed
    }

    var isBusy: Bool { phase != .idle }

    func load() async {
        guard isCurrent(), phase == .idle else { return }
        phase = .loading
        notice = Notice()
        showsBusyNote = false
        defer { phase = .idle }
        let token = await accessToken()
        guard isCurrent() else { return }
        guard let token else {
            notice.error = LoginText.signedOut
            return
        }
        let result = await api.load(accessToken: token)
        guard isCurrent() else { return }
        switch result {
        case let .success(loaded):
            changed()
            showsBusyNote = loaded.busy
            loadedCount += 1
        case let .failure(failure):
            switch failure {
            case let .answered(code, processed):
                switch code {
                case .unauthorized:
                    notice.error = LoginText.signedOut
                case .demoFailed:
                    notice.error = DemoText.loadFailed
                    notice.partial = processed.map(DemoText.partialLoaded)
                    // Some mails may be in: the parcels are read again.
                    if processed != nil { changed() }
                case .unavailable, .invalidInput, .clearConfirm, .clearFailed:
                    // Not the load failing part way: the words the app has for no answer from the server.
                    notice.error = LoginText.network
                }
            case .notSent:
                notice.error = LoginText.network
            case .unknown:
                // Whether it went through is not known (timed out, connection lost, the app went to the background):
                // the server reads on to the end whatever the app saw. No failure sentence: the tabs move to 荷物 and
                // read again, as for a load that went through. Nothing is sent again.
                changed()
                loadedCount += 1
            }
        }
    }

    /// `confirmed`: the 「本当に消す」 box. Without it nothing is sent (the Web's clear_confirm).
    /// Returns true when everything was cleared (the page closes the box).
    @discardableResult
    func clear(confirmed: Bool) async -> Bool {
        guard isCurrent(), phase == .idle else { return false }
        phase = .clearing
        notice = Notice()
        showsBusyNote = false
        defer { phase = .idle }
        guard confirmed else {
            notice.error = DemoText.clearConfirm
            return false
        }
        let token = await accessToken()
        guard isCurrent() else { return false }
        guard let token else {
            notice.error = LoginText.signedOut
            return false
        }
        let result = await api.clear(accessToken: token)
        guard isCurrent() else { return false }
        switch result {
        case .success:
            changed()
            clearedCount += 1
            notice.cleared = DemoText.cleared
            return true
        case let .failure(failure):
            switch failure {
            case let .answered(code, _):
                switch code {
                case .unauthorized: notice.error = LoginText.signedOut
                case .clearConfirm: notice.error = DemoText.clearConfirm
                case .clearFailed: notice.error = DemoText.clearFailed
                case .unavailable, .invalidInput, .demoFailed: notice.error = LoginText.network
                }
            case .notSent:
                notice.error = LoginText.network
            case .unknown:
                // Not known whether it was cleared: the parcels are read again (what is left shows it), no failure
                // sentence, and the page stays.
                changed()
            }
            return false
        }
    }
}
