//
//  NotesWritingDefaults.swift
//  Test-only defaults for the write surface, so a fake that only cares about
//  creates and renames does not have to answer for templates and reminders.
//
//  **Deliberately in the test target, not on the production protocol.**
//  `CoreNotesWriter` has no defaults to fall back on, so the compiler still
//  forces it to implement every method — which is how missing wiring gets
//  caught rather than silently doing nothing.
//

import Foundation
import MemryCore

@testable import Memry

extension NotesWriting {
    /// Refuses rather than faking success: a fake that returned an id would
    /// claim a note exists that nothing created.
    func createFromTemplate(templateId: String, title: String, folderPath: String?) async throws
        -> String
    {
        throw SyncError.Locked
    }

    func addReminder(noteId: String, remindAt: String, title: String?) async throws -> String {
        throw SyncError.Locked
    }

    func dismissReminder(id: String) async throws {}
    func snoozeReminder(id: String, until: String) async throws {}
}
