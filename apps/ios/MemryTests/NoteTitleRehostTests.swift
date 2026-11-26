import MemryCore
import SwiftUI
import Testing
import UIKit
@testable import Memry

/// The core's metadata writer with its renames held until the test lets them
/// land, so a re-hosted page reads the note before the typed title is saved.
private final class HeldRenames: NoteMetadataWriting, @unchecked Sendable {
    private let core: CoreNoteMetadataWriter
    private let lock = NSLock()
    private var held = true
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var written: [String] = []
    private var stored: [String] = []
    /// Every title written, in the order the writes reached the core.
    var titles: [String] { lock.withLock { written } }
    /// Every title the core finished writing.
    var saved: [String] { lock.withLock { stored } }
    /// Wakes a test waiting on `saved`.
    let landed = Changes()

    init(_ core: CoreNoteMetadataWriter) { self.core = core }

    func release() {
        let resumed = lock.withLock {
            held = false
            defer { waiting = [] }
            return waiting
        }
        resumed.forEach { $0.resume() }
    }

    func rename(id: String, title: String) async throws {
        await withCheckedContinuation { continuation in
            let wait = lock.withLock {
                if held { waiting.append(continuation) }
                return held
            }
            if !wait { continuation.resume() }
        }
        lock.withLock { written.append(title) }
        try await core.rename(id: id, title: title)
        lock.withLock { stored.append(title) }
        landed.changed()
    }

    func setIcon(id: String, icon: String?) async throws { try await core.setIcon(id: id, icon: icon) }
    func setTags(id: String, tags: [String]) async throws { try await core.setTags(id: id, tags: tags) }
    func setCover(id: String, url: String?, offsetY: Double) async throws {
        try await core.setCover(id: id, url: url, offsetY: offsetY)
    }
    func setAliases(id: String, aliases: [String]) async throws { try await core.setAliases(id: id, aliases: aliases) }
    func setProperty(id: String, name: String, valueJson: String) async throws {
        try await core.setProperty(id: id, name: name, valueJson: valueJson)
    }
    func clearProperty(id: String, name: String) async throws { try await core.clearProperty(id: id, name: name) }
}

/// Body pulls that reach no server and land nothing.
private final class QuietFiller: VaultFilling, @unchecked Sendable {
    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}

/// The note page with a sync pass counter the test can advance.
private struct Page: View {
    let noteId: String
    let reader: CoreNotesReader
    let writer: any NoteMetadataWriting
    let passes: SyncPasses

    var body: some View {
        NoteReadView(
            route: NoteRoute(id: noteId), reader: reader, filler: QuietFiller(), metadataWriter: writer
        )
            .environment(\.vaultSyncPasses, passes.count)
    }
}

@MainActor
@Observable
private final class SyncPasses {
    var count = 0
}

extension KeyWindowSuites {
    /// #4532: a title typed and not committed, then the page drawn again by an
    /// iPad window crossing compact and regular width.
    @Suite("Note title across a re-host", .serialized)
    @MainActor
    struct NoteTitleRehostTests {
        private struct Fixture {
            let vault: TasksTestVault
            let noteId: String
            let reader: CoreNotesReader
            let writer: HeldRenames
        }

        private func fixture(title: String = "") throws -> Fixture {
            let vault = try TasksTestVault()
            let noteId = try vault.vault.notesWriter(store: TaskTestKeychain()).create(title: title, folderPath: nil)
            return Fixture(
                vault: vault, noteId: noteId,
                reader: CoreNotesReader(vault: vault.vault, executor: .shared),
                writer: HeldRenames(peer(vault))
            )
        }

        /// The core's own writer, as another device's rename arrives: not held
        /// and not counted with the page's writes.
        private func peer(_ vault: TasksTestVault) -> CoreNoteMetadataWriter {
            CoreNoteMetadataWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        }

        /// A scene's window: a bare `UIWindow(frame:)` draws no SwiftUI content.
        private func sceneWindow() throws -> UIWindow {
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            return UIWindow(windowScene: scene)
        }

        private func host(_ page: Page, in window: UIWindow) {
            window.rootViewController = UIHostingController(rootView: page)
            window.makeKeyAndVisible()
        }

        /// The page's title field: the one text view that is not a block.
        private func titleField(in window: UIWindow) -> UITextView? {
            func find(_ view: UIView) -> UITextView? {
                if let field = view as? UITextView, !(field is BlockTextView) { return field }
                for sub in view.subviews { if let found = find(sub) { return found } }
                return nil
            }
            return window.rootViewController?.view.flatMap(find)
        }

        private func until(_ condition: () -> Bool) async {
            // Bounded by the test's time limit, not a fixed count: a CI runner
            // can take longer than any count that suits a laptop.
            while !condition(), !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        private func savedTitle(_ f: Fixture) async throws -> String? {
            try await f.reader.read(id: f.noteId)?.summary.title
        }

        /// Waits until every core read queued so far has run and the page has
        /// taken what it read: the reads share one serial executor.
        private func settleReads(_ f: Fixture) async throws {
            for _ in 0..<10 {
                _ = try await f.reader.read(id: f.noteId)
                await Task.yield()
            }
        }

        /// Types `text` into the new note's title, which has the caret, and
        /// redraws the page as a new one before the title is saved. Returns the
        /// redrawn page's title field, drawn from a read of the untitled note.
        private func typeAndRehost(
            _ text: String, _ f: Fixture, _ passes: SyncPasses, in window: UIWindow
        ) async throws -> UITextView {
            host(Page(noteId: f.noteId, reader: f.reader, writer: f.writer, passes: passes), in: window)
            await until { titleField(in: window)?.isFirstResponder == true }
            let typed = try #require(titleField(in: window), "the title field was not drawn")
            #expect(typed.isFirstResponder, "a new note's title did not take the caret")
            typed.insertText(text)
            await until { typed.text == text }

            host(Page(noteId: f.noteId, reader: f.reader, writer: f.writer, passes: passes), in: window)
            await until { titleField(in: window).map { $0 !== typed } == true }
            return try #require(titleField(in: window), "the redrawn title field was not drawn")
        }

        /// Lets the held renames land and waits for `text` to be the saved title.
        private func release(_ f: Fixture, until text: String) async throws {
            f.writer.release()
            while (try? await savedTitle(f)) != text, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(20))
            }
            #expect(try await savedTitle(f) == text, "the typed title was not saved: \(f.writer.titles)")
        }

        @Test(.timeLimit(.minutes(1))) func a_redrawn_page_shows_the_title_typed_on_the_page_before() async throws {
            let f = try fixture()
            let window = try sceneWindow()
            defer { window.isHidden = true }

            _ = try await typeAndRehost("Agent Heron", f, SyncPasses(), in: window)
            try await release(f, until: "Agent Heron")

            await until { titleField(in: window)?.text == "Agent Heron" }
            #expect(titleField(in: window)?.text == "Agent Heron")
        }

        /// The redrawn page's title had the caret while it read the note as
        /// untitled. A re-read after the save, then the caret leaving the title,
        /// must not write the stale empty title over the typed one.
        @Test(.timeLimit(.minutes(1))) func leaving_the_redrawn_title_keeps_the_typed_title() async throws {
            let f = try fixture()
            let window = try sceneWindow()
            defer { window.isHidden = true }
            let passes = SyncPasses()

            _ = try await typeAndRehost("Agent Heron", f, passes, in: window)
            try await release(f, until: "Agent Heron")
            // The save requests a sync; its pass re-reads the page.
            passes.count += 1
            try await Task.sleep(for: .milliseconds(500))
            titleField(in: window)?.resignFirstResponder()
            try await Task.sleep(for: .milliseconds(500))

            #expect(try await savedTitle(f) == "Agent Heron", "leaving the title wrote over the typed one: \(f.writer.titles)")
        }

        /// #4680: a title typed on the redrawn page before the first page's title
        /// is saved is the latest edit. The save and the re-read it causes leave
        /// it alone, and leaving the title writes it.
        @Test(.timeLimit(.minutes(1))) func a_title_typed_on_the_redrawn_page_wins() async throws {
            let f = try fixture()
            let window = try sceneWindow()
            defer { window.isHidden = true }

            let field = try await typeAndRehost("Agent Heron", f, SyncPasses(), in: window)
            await until { field.isFirstResponder }
            #expect(field.isFirstResponder, "the redrawn title did not keep the caret")
            field.insertText("Kestrel")
            await until { field.text == "Kestrel" }
            f.writer.release()
            await f.writer.landed.until { !f.writer.saved.isEmpty }
            #expect(f.writer.saved.first == "Agent Heron", "the typed title was not saved: \(f.writer.titles)")
            try await settleReads(f)
            #expect(field.text == "Kestrel", "the re-read replaced the typed title")

            field.resignFirstResponder()
            await f.writer.landed.until { f.writer.saved.count >= 2 }
            #expect(try await savedTitle(f) == "Kestrel")
            #expect(f.writer.titles == ["Agent Heron", "Kestrel"])
        }

        /// Opens a page on the note and puts the caret in its title.
        private func focusTitle(_ f: Fixture, _ passes: SyncPasses, in window: UIWindow) async throws -> UITextView {
            host(Page(noteId: f.noteId, reader: f.reader, writer: f.writer, passes: passes), in: window)
            await until { titleField(in: window) != nil }
            let field = try #require(titleField(in: window), "the title field was not drawn")
            if !field.isFirstResponder { field.becomeFirstResponder() }
            await until { field.isFirstResponder }
            // The page's focus state follows the responder a turn later.
            try await settleReads(f)
            return field
        }

        /// #4680: focus on "Foo", type "Food", a peer renames the note to "Bar",
        /// erase back to "Foo", leave. The edit came back to where it began, so
        /// nothing is written and the peer's title stands.
        @Test(.timeLimit(.minutes(1))) func an_edit_typed_back_to_its_start_writes_nothing_over_a_peer() async throws {
            let f = try fixture(title: "Foo")
            f.writer.release()
            let window = try sceneWindow()
            defer { window.isHidden = true }
            let passes = SyncPasses()

            let field = try await focusTitle(f, passes, in: window)
            #expect(field.text == "Foo")
            field.insertText("d")
            await until { field.text == "Food" }
            try await peer(f.vault).rename(id: f.noteId, title: "Bar")
            NotificationCenter.default.post(name: NoteReadViewModel.titleSaved, object: f.noteId)
            try await settleReads(f)
            #expect(field.text == "Food", "the peer's rename replaced the typed title")

            field.deleteBackward()
            await until { field.text == "Foo" }
            field.resignFirstResponder()
            await until { field.text == "Bar" }
            try await settleReads(f)

            #expect(field.text == "Bar")
            #expect(try await savedTitle(f) == "Bar")
            #expect(f.writer.titles.isEmpty, "wrote over the peer's title: \(f.writer.titles)")
        }

        /// #4680: an input method's composition survives the title changing
        /// under it. SwiftUI writes the marked text into the draft, so the draft
        /// is no longer its base and does not follow; following would replace
        /// the field's text and drop the composition.
        @Test(.timeLimit(.minutes(1))) func a_composition_in_the_title_survives_a_peer_rename() async throws {
            let f = try fixture(title: "Foo")
            f.writer.release()
            let window = try sceneWindow()
            defer { window.isHidden = true }
            let passes = SyncPasses()

            let field = try await focusTitle(f, passes, in: window)
            field.selectedRange = NSRange(location: 3, length: 0)
            field.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0))
            try await settleReads(f)
            #expect(field.markedTextRange != nil)
            try await peer(f.vault).rename(id: f.noteId, title: "Bar")
            NotificationCenter.default.post(name: NoteReadViewModel.titleSaved, object: f.noteId)
            try await settleReads(f)

            #expect(field.markedTextRange != nil, "the composition was dropped")
            #expect(field.text == "Fook")
        }
    }
}
