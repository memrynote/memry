import MemryCore
import SwiftUI
import Testing
import UIKit
@testable import Memry

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

@Suite("Line Return")
struct LineReturnTests {
    @Test func keys_after_the_newline_are_held_for_the_body() throws {
        let burst = try #require(LineReturn(previous: "F1", value: "F1 paragraph\nbo"))
        #expect(burst.line == "F1 paragraph")
        #expect(burst.held(in: "F1 paragraph\nbo") == "bo")
        #expect(burst.held(in: "F1 paragraph\nbody") == "body")
    }

    @Test func a_return_inside_the_title_keeps_the_text_after_the_caret() throws {
        let burst = try #require(LineReturn(previous: "F1 paragraph", value: "F1 para\ngraph"))
        #expect(burst.line == "F1 paragraph")
        #expect(burst.held(in: "F1 para\nxygraph") == "xy")
    }

    @Test func a_submitted_return_holds_keys_typed_at_the_caret() {
        let burst = LineReturn(submitted: "F1 paragraph")
        #expect(burst.line == "F1 paragraph")
        #expect(burst.held(in: "F1 paragraphbody") == "body")
        #expect(burst.held(in: "F1 paragraph") == "")
    }

    @Test func an_edit_without_a_newline_is_no_return() {
        #expect(LineReturn(previous: "F1", value: "F1 p") == nil)
    }

    @Test func a_backspace_past_the_return_holds_nothing() throws {
        let burst = try #require(LineReturn(previous: "F1", value: "F1\n"))
        #expect(burst.held(in: "F1") == nil)
    }
}

/// #4705: keys typed into a note's title as one burst, the way a hardware
/// keyboard or a text expander delivers them, before the page draws again.
@Suite("Note title bursts", .serialized)
@MainActor
struct NoteTitleBurstTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let reader: CoreNotesReader
    }

    private func fixture() throws -> Fixture {
        let vault = try TasksTestVault()
        let noteId = try vault.vault.notesWriter(store: TaskTestKeychain()).create(title: "", folderPath: nil)
        return Fixture(vault: vault, noteId: noteId, reader: CoreNotesReader(vault: vault.vault, executor: .shared))
    }

    /// Opens the new note's page in a scene window; its title takes the caret.
    private func open(_ f: Fixture) async throws -> (UIWindow, UITextView) {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let writer = CoreNoteMetadataWriter(vault: f.vault.vault, store: TaskTestKeychain(), executor: .shared)
        window.rootViewController = UIHostingController(rootView: NoteReadView(
            route: NoteRoute(id: f.noteId), reader: f.reader, filler: QuietFiller(),
            editor: CoreBlockEditor(vault: f.vault.vault, store: TaskTestKeychain(), executor: .shared),
            metadataWriter: writer
        ))
        window.makeKeyAndVisible()
        await until { title(in: window)?.isFirstResponder == true }
        let field = try #require(title(in: window), "the title field was not drawn")
        #expect(field.isFirstResponder, "a new note's title did not take the caret")
        // The page's focus state follows the responder a turn later.
        try await settle(f)
        return (window, field)
    }

    private func views<T: UIView>(_ type: T.Type, in window: UIWindow) -> [T] {
        func all(_ view: UIView) -> [T] { ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap(all) }
        return window.rootViewController?.view.map(all) ?? []
    }

    /// The title field: the one text view that is not a block.
    private func title(in window: UIWindow) -> UITextView? {
        views(UITextView.self, in: window).first { !($0 is BlockTextView) }
    }

    private func until(_ condition: () -> Bool) async {
        for _ in 0..<300 where !condition() {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    private func settle(_ f: Fixture) async throws {
        for _ in 0..<10 {
            _ = try await f.reader.read(id: f.noteId)
            await Task.yield()
        }
    }

    private func stored(_ f: Fixture) async throws -> (title: String?, body: [String]) {
        let detail = try await f.reader.read(id: f.noteId)
        let blocks = try await f.reader.blocks(id: f.noteId) ?? []
        return (detail?.summary.title, blocks.map { $0.inline.map(\.text).joined() })
    }

    /// Waits for the stored title and body to be `title` and `body`.
    private func expectStored(_ f: Fixture, title: String, body: [String]) async throws {
        for _ in 0..<300 {
            let now = try await stored(f)
            if now.title == title, now.body == body { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let now = try await stored(f)
        #expect(now.title == title, "\(now)")
        #expect(now.body == body, "\(now)")
    }

    /// The body's first block has the caret and the keys typed after the
    /// title's Return; once it lets go, the note stores both.
    private func expectBody(in window: UIWindow, _ f: Fixture) async throws {
        await until { views(BlockTextView.self, in: window).first?.text == "body" }
        let block = try #require(views(BlockTextView.self, in: window).first, "the body has no block")
        #expect(block.isFirstResponder, "Return left the caret in the title")
        #expect(block.text == "body")
        block.resignFirstResponder()
        try await expectStored(f, title: "F1 paragraph", body: ["body"])
    }

    @Test(.timeLimit(.minutes(1))) func keys_typed_after_the_titles_return_land_in_the_body() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "F1 paragraph\nbody" { field.insertText(String(key)) }

        try await expectBody(in: window, f)
        #expect(field.text == "F1 paragraph")
    }

    /// The edit ended while the title kept the caret, as when the app
    /// resumes: the next keys still land, and Return still moves to the body.
    @Test(.timeLimit(.minutes(1))) func keys_after_an_edit_ended_under_the_caret_land() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "F1 par" { field.insertText(String(key)) }
        field.resignFirstResponder()
        field.becomeFirstResponder()
        for key in "agraph\nbody" { field.insertText(String(key)) }

        try await expectBody(in: window, f)
    }
}
