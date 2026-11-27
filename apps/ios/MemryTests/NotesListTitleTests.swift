import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

// A new note's title, still holding the caret when Back is tapped, commits as
// the page leaves. It lands after the list's re-read on Back, and the phone
// list showed the note as Untitled until the next visit.

extension KeyWindowSuites {
    @MainActor
    @Suite("Notes list titles")
    struct NotesListTitleTests {
        @Test("a title that lands after the list's last read shows in its row", .timeLimit(.minutes(1)))
        func aTitleLandingAfterTheReadShowsInTheRow() async throws {
            let vault = try TasksTestVault()
            let store = TaskTestKeychain()
            let writer = try vault.vault.notesWriter(store: store)
            let noteId = try writer.create(title: "", folderPath: nil)
            let model = VaultBrowseViewModel(vault: vault.vault, executor: .shared, store: store)
            await model.loadIfNeeded()
            // Written after the first read, so only the list's re-read on
            // appear shows it: its row marks that re-read as done.
            _ = try writer.create(title: "Milk", folderPath: nil)
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            // The phone list: an iPad simulator's regular width draws the
            // split view, which re-reads after each write (#5883).
            window.rootViewController = UIHostingController(
                rootView: NotesListView(model: model).environment(\.horizontalSizeClass, .compact)
            )
            window.makeKeyAndVisible()
            defer { window.isHidden = true }

            func title() -> String? { model.outline?.rootNotes.first { $0.id == noteId }?.title }
            try await wait(10) { model.outline?.rootNotes.count == 2 }
            try #require(model.outline?.rootNotes.count == 2)
            #expect(title() == "")

            let page = NoteMetadataViewModel(noteId: noteId, writer: model.metadataWriter)
            await page.rename(to: "Groceries", current: "")

            try await wait(10) { title() == "Groceries" }
            #expect(title() == "Groceries")
        }
    }
}
