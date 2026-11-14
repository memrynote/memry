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
    /// Every title written, in the order the writes reached the core.
    var titles: [String] { lock.withLock { written } }

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

    private func fixture() throws -> Fixture {
        let vault = try TasksTestVault()
        let noteId = try vault.vault.notesWriter(store: TaskTestKeychain()).create(title: "", folderPath: nil)
        let core = CoreNoteMetadataWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        return Fixture(
            vault: vault, noteId: noteId,
            reader: CoreNotesReader(vault: vault.vault, executor: .shared),
            writer: HeldRenames(core)
        )
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
        for _ in 0..<300 where !condition() {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    private func savedTitle(_ f: Fixture) async throws -> String? {
        try await f.reader.read(id: f.noteId)?.summary.title
    }

    /// Types `text` into the new note's title, which has the caret, and
    /// redraws the page as a new one before the title is saved.
    private func typeAndRehost(_ text: String, _ f: Fixture, _ passes: SyncPasses, in window: UIWindow) async throws {
        host(Page(noteId: f.noteId, reader: f.reader, writer: f.writer, passes: passes), in: window)
        await until { titleField(in: window)?.isFirstResponder == true }
        let typed = try #require(titleField(in: window), "the title field was not drawn")
        #expect(typed.isFirstResponder, "a new note's title did not take the caret")
        typed.insertText(text)
        await until { typed.text == text }

        host(Page(noteId: f.noteId, reader: f.reader, writer: f.writer, passes: passes), in: window)
        await until { titleField(in: window).map { $0 !== typed } == true }
        // The redrawn page has read the note: its title field is drawn.
        try await Task.sleep(for: .milliseconds(300))
        f.writer.release()
        for _ in 0..<300 where (try? await savedTitle(f)) != text {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(try await savedTitle(f) == text, "the typed title was not saved: \(f.writer.titles)")
    }

    @Test(.timeLimit(.minutes(1))) func a_redrawn_page_shows_the_title_typed_on_the_page_before() async throws {
        let f = try fixture()
        let window = try sceneWindow()
        defer { window.isHidden = true }

        try await typeAndRehost("Agent Heron", f, SyncPasses(), in: window)

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

        try await typeAndRehost("Agent Heron", f, passes, in: window)
        // The save requests a sync; its pass re-reads the page.
        passes.count += 1
        try await Task.sleep(for: .milliseconds(500))
        titleField(in: window)?.resignFirstResponder()
        try await Task.sleep(for: .milliseconds(500))

        #expect(try await savedTitle(f) == "Agent Heron", "leaving the title wrote over the typed one: \(f.writer.titles)")
    }
}

