import Foundation
import MemryCore
import Testing

@testable import Memry

// RD03 / RD04: the composer replaces quick add and the Add Task sheet. Typed
// tokens fill the chips; a chip set by hand wins for its property; Return
// ("next") keeps the context for the next task; the When sheet's answer only
// overrides what it changed. Over a real scratch vault and the real core.

@MainActor
@Suite("Task composer", .serialized)
struct TasksComposerTests {
    @Test func typed_tokens_fill_the_chips() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Launch")
        await vault.store.load()
        let text = "[agent] Call the bank @tomorrow 10am !high #money"
        let parse = await vault.store.parseQuickAdd(text)

        let values = resolve(vault, text: text, parse: parse, draft: TaskComposerDraft(), request: TaskComposerRequest())
        #expect(values.title == "[agent] Call the bank")
        #expect(values.dueDate == "2026-01-15")
        #expect(values.dueTime == "10:00")
        #expect(values.priority == 3)
        #expect(values.tags == ["money"])
        // No `+project` typed: the store's chain (here the one live project).
        #expect(values.projectId == project)
    }

    @Test func a_chip_set_by_hand_wins_over_the_text() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Launch")
        await vault.store.load()
        let text = "[agent] Report @tomorrow !low"
        let parse = await vault.store.parseQuickAdd(text)
        var draft = TaskComposerDraft()
        draft.due = .set(date: "2026-01-20", time: nil)
        draft.priority = 4
        draft.projectId = project
        draft.tags = ["extra"]

        let values = resolve(vault, text: text, parse: parse, draft: draft, request: TaskComposerRequest())
        #expect(values.dueDate == "2026-01-20")
        #expect(values.dueTime == nil)
        #expect(values.priority == 4)
        #expect(values.projectId == project)
        #expect(values.tags == ["extra"])

        draft.due = .cleared
        let cleared = resolve(vault, text: text, parse: parse, draft: draft, request: TaskComposerRequest())
        #expect(cleared.dueDate == nil)
    }

    @Test func the_view_and_the_request_seed_what_the_text_leaves_open() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Board")
        await vault.store.load()
        let request = TaskComposerRequest(projectId: project, dueDate: "2026-01-16", priority: 2)

        let values = resolve(vault, text: "[agent] plain", parse: nil, draft: TaskComposerDraft(), request: request)
        #expect(values.title == "[agent] plain")
        #expect(values.projectId == project)
        #expect(values.dueDate == "2026-01-16")
        #expect(values.priority == 2)
        #expect(!TaskComposerValues.resolve(
            text: "  ", parse: nil, draft: TaskComposerDraft(), request: request, fallbackDue: nil,
            resolveProject: { _, _ in project }
        ).canSubmit)
    }

    @Test func next_keeps_the_context_and_clears_the_rest() {
        var draft = TaskComposerDraft()
        draft.notes = "call first"
        draft.due = .set(date: "2026-01-20", time: "09:00")
        draft.priority = 3
        draft.projectId = "p1"
        draft.parentId = "t1"
        draft.tags = ["x"]
        draft.startDate = "2026-01-18"
        draft.reminder = Date()

        draft.resetForNext()
        #expect(draft.notes.isEmpty)
        #expect(draft.due == .set(date: "2026-01-20", time: nil))
        #expect(draft.priority == nil)
        #expect(draft.projectId == "p1")
        #expect(draft.parentId == "t1")
        #expect(draft.tags.isEmpty)
        #expect(draft.startDate == nil)
        #expect(draft.reminder == nil)
    }

    @Test func the_when_sheet_overrides_only_what_it_changed() {
        var draft = TaskComposerDraft()
        var original = TaskWhenDraft(values: TaskComposerValues(
            title: "t", dueDate: "2026-01-15", dueTime: "10:00", priority: 0, projectId: "p", statusId: nil,
            parentId: nil, tags: [], rule: nil, repeatFrom: nil, startDate: nil, reminder: nil
        ))
        var edited = original
        edited.startDate = "2026-01-14"
        draft.apply(edited, from: original)
        // The date came from the text and was not touched: it keeps following the text.
        #expect(draft.due == nil)
        #expect(draft.startDate == "2026-01-14")

        original = edited
        edited.date = "2026-01-22"
        draft.apply(edited, from: original)
        #expect(draft.due == .set(date: "2026-01-22", time: "10:00"))
    }

    @Test func creating_writes_every_field_and_the_reminder() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Launch")
        await vault.store.load()
        var draft = TaskComposerDraft()
        draft.projectId = project
        draft.startDate = "2026-01-14"
        let values = resolve(vault, text: "[agent] full #one", parse: await vault.store.parseQuickAdd("[agent] full #one"),
                             draft: draft, request: TaskComposerRequest())

        let id = try #require(await vault.store.createComposedTask(values, notes: "the notes", noteTitles: [], picks: QuickAddPicks()))
        let task = try #require(vault.store.items[id])
        #expect(task.title == "[agent] full")
        #expect(task.description == "the notes")
        #expect(task.projectId == project)
        #expect(task.startDate == "2026-01-14")
        #expect(task.tags == ["one"])
        #expect(vault.store.undoable?.message == TasksCopy.created)
    }

    private func resolve(
        _ vault: TasksTestVault, text: String, parse: QuickAddParse?, draft: TaskComposerDraft,
        request: TaskComposerRequest
    ) -> TaskComposerValues {
        TaskComposerValues.resolve(
            text: text, parse: parse, draft: draft, request: request, fallbackDue: nil,
            resolveProject: { parsed, preferred in vault.store.resolveProjectId(parsed: parsed, preferred: preferred) }
        )
    }
}
