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
            let noteId = try vault.vault.notesWriter(store: store).create(title: "", folderPath: nil)
            let model = VaultBrowseViewModel(vault: vault.vault, executor: .shared, store: store)
            await model.loadIfNeeded()
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIHostingController(rootView: NotesListView(model: model))
            window.makeKeyAndVisible()
            defer { window.isHidden = true }

            // The reads share one serial executor: these return once the
            // list's own reads, the re-read on appear among them, have run.
            for _ in 0 ..< 10 {
                _ = try await model.reader.list()
                await Task.yield()
            }
            #expect(model.outline?.rootNotes.map(\.title) == [""])

            let page = NoteMetadataViewModel(noteId: noteId, writer: model.metadataWriter)
            await page.rename(to: "Groceries", current: "")

            try await wait { model.outline?.rootNotes.map(\.title) == ["Groceries"] }
            #expect(model.outline?.rootNotes.map(\.title) == ["Groceries"])
        }
    }
}
