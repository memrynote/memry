import Foundation
import MemryCore
import Testing

@testable import Memry

// #4376: desktop's width modes. A page's own override wins, then this
// device's editor width; the reading cap applies only at normal width.

@MainActor
@Suite("Editor width")
struct EditorWidthTests {
    @Test(arguments: [
        (EditorWidth.normal, Bool?.none, false),
        (.full, nil, true),
        (.normal, true, true),
        (.full, false, false),
        (.full, true, true),
        (.normal, false, false),
    ])
    func an_override_wins_over_the_device_width(global: EditorWidth, override: Bool?, full: Bool) {
        #expect(global.isFull(override: override) == full)
    }

    @Test func the_journal_follows_the_device_until_toggled_and_keeps_its_override() throws {
        let defaults = try #require(UserDefaults(suiteName: "editor-width-\(UUID().uuidString)"))
        let local = LocalSettings(defaults: defaults)
        #expect(local.editorWidth == .normal)
        #expect(local.journalFullWidth == nil)
        #expect(!local.journalIsFullWidth)

        local.editorWidth = .full
        #expect(local.journalIsFullWidth, "no override: the journal follows the device")

        local.journalFullWidth = false
        #expect(!local.journalIsFullWidth, "the journal's override wins")

        let reopened = LocalSettings(defaults: defaults)
        #expect(reopened.editorWidth == .full)
        #expect(reopened.journalFullWidth == false)
    }

    /// The note toggle over the real core: the effective width, flipped,
    /// lands in the note's `fullWidth` and reads back.
    @Test func the_note_toggle_writes_the_flipped_effective_width() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memry-width-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let vault = try Vault.open(vaultId: "vault-width", directory: directory.path)
        let writer = CoreNotesWriter(vault: vault, store: TaskTestKeychain(), executor: CoreExecutor())
        let id = try await writer.create(title: "Wide", folderPath: nil)
        let actions = NotePageActions(noteId: id, writer: writer)

        await actions.loadFullWidth()
        #expect(actions.fullWidth == nil)

        // The device is Full and the note has no override: the page is full,
        // so the toggle pins it to normal, as desktop's does.
        await actions.toggleFullWidth(isFull: EditorWidth.full.isFull(override: actions.fullWidth))
        #expect(actions.fullWidth == false)
        #expect(try await writer.fullWidth(id: id) == false)

        await actions.toggleFullWidth(isFull: EditorWidth.full.isFull(override: actions.fullWidth))
        #expect(try await writer.fullWidth(id: id) == true)
    }
}
