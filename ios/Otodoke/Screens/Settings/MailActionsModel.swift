// 「これは荷物」 (読まなかったメール) and 「読み取る」 (未読のメール), done inside the app. The Web does the work
// (POST /api/mail/mark-parcel and /api/mail/read-waiting, MailActionsAPI); this model keeps what the pages show:
// which row is working, the sentence under the lead, the spinner of 「読み取る」. One press is one request:
// a second press while one runs does nothing (the buttons are not disabled, as the Web's PressButton), and a
// request is never sent again by itself. Every answer, and a request whose result is not known, ends in a read
// of the settings again (`reload`), so the list shows what the server did.

import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class MailActionsModel {
    /// A sentence under the page's lead (the Web's SENDER_NOTES): green when it went through, red when not.
    struct Note: Equatable {
        let text: String
        let isError: Bool
        /// The Web's 「荷物を登録する」 link goes with it: the parcel can be registered by hand.
        let offersRegister: Bool
    }

    /// The row being marked (nil: none). Another press is ignored while it is set.
    private(set) var markingID: String?
    /// What 「これは荷物」 came to, shown on the page of the dropped mail.
    private(set) var markNote: Note?
    /// 「読み取る」 is working.
    private(set) var isReading = false
    /// Why 「読み取る」 did not go through (the Web's red line under the button).
    private(set) var readNote: String?
    private(set) var isAutomaticallyReading = false
    private(set) var automaticReadNote: String?

    @ObservationIgnored private var automaticTask: Task<Void, Never>?
    @ObservationIgnored private var automaticQueue: [AIReadingConsentSaveReceipt] = []
    @ObservationIgnored private var activeAutomaticGrant: AIReadingConsentSaveReceipt?
    @ObservationIgnored private var consumedGrants: [AIReadingConsentSaveReceipt] = []
    @ObservationIgnored private var retired = false

    @ObservationIgnored private let api: any MailActionsAPI
    @ObservationIgnored private let accessToken: @MainActor () async -> String?
    @ObservationIgnored private let reload: @MainActor () async -> Void
    @ObservationIgnored private let mayRead: @MainActor () -> Bool
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let authorizeAfterConsent: @MainActor (AIReadingConsentSaveReceipt) async -> Bool
    @ObservationIgnored private let isCurrentGrant: @MainActor (AIReadingConsentSaveReceipt) -> Bool
    @ObservationIgnored private let permissionGeneration: @MainActor () -> Int
    @ObservationIgnored private let requestReadingConsent: @MainActor () -> Void

    /// Tells the other tabs 「古くなった」 (ParcelWriter.announceOutsideChange): after 「読み取る」 only, which can add parcels.
    @ObservationIgnored private let announceChange: @MainActor () -> Void
    /// The page was left while a request ran: its answer leaves no note behind.
    @ObservationIgnored private var discardMarkNote = false
    @ObservationIgnored private var discardReadNote = false

    init(
        api: any MailActionsAPI,
        accessToken: @escaping @MainActor () async -> String?,
        reload: @escaping @MainActor () async -> Void,
        announceChange: @escaping @MainActor () -> Void = {},
        mayRead: @escaping @MainActor () -> Bool = { true },
        requestReadingConsent: @escaping @MainActor () -> Void = {},
        isCurrent: @escaping @MainActor () -> Bool = { true },
        authorizeAfterConsent: @escaping @MainActor (AIReadingConsentSaveReceipt) async -> Bool = { _ in false },
        isCurrentGrant: @escaping @MainActor (AIReadingConsentSaveReceipt) -> Bool = { _ in false },
        permissionGeneration: @escaping @MainActor () -> Int = { 0 }
    ) {
        self.api = api
        self.accessToken = accessToken
        self.reload = reload
        self.announceChange = announceChange
        self.mayRead = mayRead
        self.isCurrent = isCurrent
        self.authorizeAfterConsent = authorizeAfterConsent
        self.isCurrentGrant = isCurrentGrant
        self.permissionGeneration = permissionGeneration
        self.requestReadingConsent = requestReadingConsent
    }

    /// 「これは荷物」 on the row of screen_events `id`.
    func markAsParcel(id: String) async {
        guard !retired, isCurrent(), markingID == nil else { return }
        markingID = id
        discardMarkNote = false
        markNote = nil
        defer { markingID = nil }
        guard let token = await accessToken() else {
            setMarkNote(Note(text: LoginText.signedOut, isError: true, offersRegister: false))
            return
        }
        guard !retired, isCurrent() else { return }
        do {
            let outcome = try await api.markParcel(id: id, accessToken: token)
            setMarkNote(Note(text: SettingsMailText.note(for: outcome), isError: false, offersRegister: true))
        } catch {
            setMarkNote(Self.note(for: error))
        }
        // Whatever came of it, the list is read again: a mark that was made shows as 荷物として記録済み.
        // (No change is announced: a mark adds no parcel.)
        if !retired, isCurrent() { await reload() }
    }

    /// Manual retry uses the existing empty body, never a saved grant receipt.
    func readWaiting() async {
        guard !retired, isCurrent(), !isReading else { return }
        guard mayRead() else { readNote = nil; requestReadingConsent(); return }
        isReading = true
        automaticReadNote = nil
        defer { finishReading() }
        await performRead(afterConsent: nil)
    }

    /// Owns work after the saving view disappears. Pending and sent receipts are kept distinct.
    func startReadingAfterConsent(_ receipt: AIReadingConsentSaveReceipt) {
        guard !retired, isCurrent(), receipt.decision == .allowed,
              !consumedGrants.contains(receipt), !automaticQueue.contains(receipt), activeAutomaticGrant != receipt else { return }
        automaticQueue.append(receipt)
        drainAutomaticReads()
    }

    private func drainAutomaticReads() {
        guard !retired, automaticTask == nil, !isReading else { return }
        while !automaticQueue.isEmpty {
            let receipt = automaticQueue.removeFirst()
            guard isCurrent() else { continue }
            activeAutomaticGrant = receipt
            // Reserve the shared operation synchronously; a manual press cannot race the new task.
            isReading = true
            isAutomaticallyReading = true
            automaticReadNote = nil
            automaticTask = Task { [weak self] in
                guard let self else { return }
                await self.performRead(afterConsent: receipt)
                self.automaticTask = nil
                self.activeAutomaticGrant = nil
                self.finishReading()
            }
            return
        }
    }

    private func finishReading() {
        isReading = false
        isAutomaticallyReading = false
        if !retired { drainAutomaticReads() }
    }

    private func performRead(afterConsent receipt: AIReadingConsentSaveReceipt?) async {
        let permissionAtStart = permissionGeneration()
        discardReadNote = false
        readNote = nil
        guard !retired, isCurrent(), !Task.isCancelled else { return }
        if let receipt, !(await authorizeAfterConsent(receipt)) { return }
        let token = await accessToken()
        // The token lookup may have suspended through a withdrawal or a different signed-in user.
        guard !retired, isCurrent(), !Task.isCancelled else { return }
        if let receipt {
            guard await authorizeAfterConsent(receipt) else { return }
        } else {
            guard permissionGeneration() == permissionAtStart else { return }
            guard mayRead() else { requestReadingConsent(); return }
        }
        guard let token else { setReadNote(LoginText.signedOut); return }
        guard !retired, isCurrent(), !Task.isCancelled else { return }
        if let receipt {
            guard !consumedGrants.contains(receipt) else { return }
            consumedGrants.append(receipt)
        }
        do {
            let result: ReadWaitingResult
            if let receipt {
                result = try await api.readWaiting(afterConsent: receipt, accessToken: token)
            } else {
                result = try await api.readWaiting(accessToken: token)
            }
            guard !retired, isCurrent(), !Task.isCancelled else { return }
            if !(receipt.map(isCurrentGrant) ?? (permissionGeneration() == permissionAtStart)) {
                // An older grant can still have added parcels, but cannot speak for a new choice.
            } else if result.stopped {
                setReadNote(SettingsMailText.readUnavailableNotice)
            } else if result.overLimit {
                setReadNote(SettingsMailText.readOverLimitNotice)
            }
        } catch {
            guard !retired, isCurrent(), !Task.isCancelled else { return }
            if receipt.map(isCurrentGrant) ?? (permissionGeneration() == permissionAtStart) {
                setReadNote(Self.readText(for: error))
                if error == .aiConsentRequired || error == .unavailable {
                    requestReadingConsent()
                    return
                }
            }
        }
        // No POST is repeated, including an unknown result. Read the resulting parcels and counters.
        guard !retired, isCurrent(), !Task.isCancelled else { return }
        announceChange()
        await reload()
    }

    func retire() {
        retired = true
        automaticTask?.cancel()
        automaticTask = nil
        automaticQueue.removeAll()
        activeAutomaticGrant = nil
        consumedGrants.removeAll()
        isReading = false
        isAutomaticallyReading = false
        readNote = nil
        automaticReadNote = nil
        markingID = nil
        markNote = nil
        discardMarkNote = true
        discardReadNote = true
    }

    /// The notes go when the page is left (the Web's note belongs to one page load). A request still running
    /// leaves no note when it ends.
    func clearNotes() {
        if markingID != nil { discardMarkNote = true }
        markNote = nil
    }

    func clearReadNote() {
        if isReading { discardReadNote = true }
        readNote = nil
    }

    /// Shows a note and reads it aloud (VoiceOver); nothing when the page was left meanwhile.
    private func setMarkNote(_ note: Note?) {
        guard !retired, isCurrent(), !discardMarkNote, let note else { return }
        markNote = note
        AccessibilityNotification.Announcement(note.text).post()
    }

    private func setReadNote(_ text: String?) {
        guard !retired, isCurrent(), let text else { return }
        if isAutomaticallyReading { automaticReadNote = text }
        guard !discardReadNote else { return }
        readNote = text
        AccessibilityNotification.Announcement(text).post()
    }

    // MARK: the words of a failure

    /// nil: no sentence (the result is not known; the list is read again and tells).
    private static func note(for failure: MailAPIFailure) -> Note? {
        guard let text = markText(for: failure) else { return nil }
        return Note(text: text, isError: true, offersRegister: false)
    }

    private static func markText(for failure: MailAPIFailure) -> String? {
        switch failure {
        case .unauthorized: LoginText.signedOut
        case .unknownResult: nil
        case .aiConsentRequired: nil
        case .invalidInput, .notFound, .markFailed, .unavailable, .readFailed, .network: SettingsMailText.markFailed
        }
    }

    /// `nil` when the result is not known: no sentence, only a new read.
    private static func readText(for failure: MailAPIFailure) -> String? {
        switch failure {
        case .readFailed: return SettingsMailText.readFailed
        case .unauthorized: return LoginText.signedOut
        case .unknownResult: return nil
        case .aiConsentRequired: return nil
        case .unavailable: return AIReadingConsentText.readFailed
        case .invalidInput, .notFound, .markFailed, .network: return SettingsMailText.unknownFailure
        }
    }
}
