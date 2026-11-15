import MemryCore
import Testing
@testable import Memry

/// #4705: an empty day's first line, typed key by key through the field's
/// draft into a real day page.
@MainActor
@Suite("Journal first line", .serialized)
struct JournalFirstLineTests {
    private func page(_ vault: JournalTestVault, date: String = JournalTestVault.today) -> JournalDayPageModel {
        let context = JournalVaultContext(
            reader: CoreNotesReader(vault: vault.vault, executor: CoreExecutor()),
            filler: nil, writer: nil, editor: nil, metadataWriter: nil, search: nil, noteTasks: nil
        )
        vault.store.context = context
        return JournalDayPageModel(store: vault.store, date: date, context: context)
    }

    /// Types `keys` one at a time, as the keyboard does.
    private func type(_ keys: String, into draft: JournalFirstLineDraft, write: @escaping JournalFirstLineDraft.Write) {
        for key in keys { draft.typed(draft.text + String(key), write: write) }
    }

    private func body(_ page: JournalDayPageModel) async throws -> [String] {
        let blocks = try await page.bridge.blocks(id: page.read.route.id) ?? []
        return blocks.map { $0.inline.map(\.text).joined() }
    }

    @Test func a_failed_write_keeps_the_line_once() async throws {
        let vault = try JournalTestVault()
        // No such day: `editDay` fails, as when sync makes the day meanwhile.
        let failing = page(vault, date: "2099-02-30")
        let draft = JournalFirstLineDraft()
        draft.focused = true

        type("hello\nmo", into: draft) { await failing.writeFirstLine($0, carrying: $1) }
        await draft.landing?.value

        #expect(draft.text == "hello\nmo", "the line was added again or lost")
        #expect(draft.returned == nil, "the failed Return still holds its keys")

        let working = page(vault)
        draft.focused = false
        draft.landAll { await working.writeFirstLine($0, carrying: $1) }
        await draft.landing?.value
        #expect(try await body(working) == ["hello", "mo"])
    }

    @Test func lines_typed_fast_land_in_order() async throws {
        let vault = try JournalTestVault()
        let page = page(vault)
        let draft = JournalFirstLineDraft()
        draft.focused = true
        let write: JournalFirstLineDraft.Write = { await page.writeFirstLine($0, carrying: $1) }

        type("a\nb\nc", into: draft, write: write)
        // The caret leaves before the first write lands: the keys held for
        // its block land after it, each on a line of its own.
        draft.focused = false
        draft.landAll(write: write)
        for _ in 0..<300 where !draft.text.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        await draft.landing?.value

        #expect(try await body(page) == ["a", "b", "c"])
        #expect(page.editor.session.titleBurst == nil, "the caret was taken back after the user moved it")
        #expect(draft.text.isEmpty)
    }

    @Test func return_hands_the_new_block_a_return_at_any_speed() {
        let draft = JournalFirstLineDraft()
        let write: JournalFirstLineDraft.Write = { _, _ in true }

        type("line\n", into: draft, write: write)
        #expect(draft.takeHeld(true) == "\n", "a Return typed at normal speed made no new block")

        type("line\nmore", into: draft, write: write)
        #expect(draft.takeHeld(true) == "\nmore")
        #expect(draft.text.isEmpty)
    }

    @Test func keys_stay_in_the_field_when_the_block_refuses_the_caret() {
        let draft = JournalFirstLineDraft()
        type("line\nmore", into: draft) { _, _ in true }

        #expect(draft.takeHeld(false) == nil)
        #expect(draft.text == "more")
        #expect(draft.returned == nil)
    }
}
