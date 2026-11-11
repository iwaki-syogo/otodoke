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

    @ObservationIgnored private let api: any MailActionsAPI
    @ObservationIgnored private let accessToken: @MainActor () async -> String?
    @ObservationIgnored private let reload: @MainActor () async -> Void

    /// Tells the other tabs 「古くなった」 (ParcelWriter.announceOutsideChange): after 「読み取る」 only, which can add parcels.
    @ObservationIgnored private let announceChange: @MainActor () -> Void
    /// The page was left while a request ran: its answer leaves no note behind.
    @ObservationIgnored private var discardMarkNote = false
    @ObservationIgnored private var discardReadNote = false

    init(
        api: any MailActionsAPI,
        accessToken: @escaping @MainActor () async -> String?,
        reload: @escaping @MainActor () async -> Void,
        announceChange: @escaping @MainActor () -> Void = {}
    ) {
        self.api = api
        self.accessToken = accessToken
        self.reload = reload
        self.announceChange = announceChange
    }

    /// 「これは荷物」 on the row of screen_events `id`.
    func markAsParcel(id: String) async {
        guard markingID == nil else { return }
        markingID = id
        discardMarkNote = false
        markNote = nil
        defer { markingID = nil }
        guard let token = await accessToken() else {
            setMarkNote(Note(text: LoginText.signedOut, isError: true, offersRegister: false))
            return
        }
        do {
            let outcome = try await api.markParcel(id: id, accessToken: token)
            setMarkNote(Note(text: SettingsMailText.note(for: outcome), isError: false, offersRegister: true))
        } catch {
            setMarkNote(Self.note(for: error))
        }
        // Whatever came of it, the list is read again: a mark that was made shows as 荷物として記録済み.
        // (No change is announced: a mark adds no parcel.)
        await reload()
    }

    /// 「読み取る」: up to 20 waiting mails are read on the server (it takes a while).
    func readWaiting() async {
        guard !isReading else { return }
        isReading = true
        discardReadNote = false
        readNote = nil
        defer { isReading = false }
        guard let token = await accessToken() else {
            setReadNote(LoginText.signedOut)
            return
        }
        do {
            let result = try await api.readWaiting(accessToken: token)
            // Stopped first (nothing to retry), then the limit (the Web's order); a read that went through says nothing.
            if result.stopped {
                setReadNote(SettingsMailText.readUnavailableNotice)
            } else if result.overLimit {
                setReadNote(SettingsMailText.readOverLimitNotice)
            }
        } catch {
            setReadNote(Self.readText(for: error))
        }
        // Parcels may have been added (also by a run that failed or whose result is not known): the other tabs read again.
        announceChange()
        // The count is read again either way: some of the mails may have been read before it failed.
        await reload()
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
        guard !discardMarkNote, let note else { return }
        markNote = note
        AccessibilityNotification.Announcement(note.text).post()
    }

    private func setReadNote(_ text: String?) {
        guard !discardReadNote, let text else { return }
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
        case .invalidInput, .notFound, .markFailed, .unavailable, .readFailed, .network: SettingsMailText.markFailed
        }
    }

    /// `nil` when the result is not known: no sentence, only a new read.
    private static func readText(for failure: MailAPIFailure) -> String? {
        switch failure {
        case .readFailed: return SettingsMailText.readFailed
        case .unauthorized: return LoginText.signedOut
        case .unknownResult: return nil
        case .invalidInput, .notFound, .markFailed, .unavailable, .network: return SettingsMailText.unknownFailure
        }
    }
}
