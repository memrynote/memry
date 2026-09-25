import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// TP054 / TP056: the note screen's task writes and the task half of search,
// over a real scratch vault and the real core. The rules (project
// resolution, subtask parenting, the line tick) are the core's and pinned in
// Rust; these assert that the shell reaches them and reports what came back.

@MainActor
@Suite("Tasks in notes", .serialized)
struct TasksNotesTests {
    /// A note holding one checklist item.
    private struct ChecklistNote {
        let note: String
        let block: String
        let writer: NotesWriter
    }

    private func noteWithChecklist(
        _ vault: TasksTestVault, text: String = "[agent] from a note"
    ) throws -> ChecklistNote {
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let note = try writer.create(title: "[agent] note", folderPath: nil)
        let block = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: note,
            edit: .insertBlock(kind: "checkListItem", afterBlockId: nil, text: text, newBlockId: block)
        )
        return ChecklistNote(note: note, block: block, writer: writer)
    }

    private func actions(_ vault: TasksTestVault, note: String) -> NoteTaskActions {
        let actions = NoteTaskActions(
            noteId: note,
            tasks: CoreNoteTasks(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        )
        actions.clock = { TasksTestVault.referenceNow }
        return actions
    }

    @Test func converting_a_checklist_item_makes_a_task_written_in_the_note() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let made = try noteWithChecklist(vault)
        let note = made.note
        let block = made.block
        let actions = actions(vault, note: note)

        let id = try #require(await actions.convert(blockId: block))

        let task = try #require(try vault.tasks.get(id: id))
        #expect(task.title == "[agent] from a note")
        #expect(task.projectId == project)
        #expect(task.sourceNoteId == note)
        #expect(actions.failure == nil)
        let line = try vault.vault.notes().blocks(id: note)?.first { $0.id == block }
        #expect(line?.kind == "taskBlock")
    }

    @Test func a_checklist_item_nested_under_a_task_line_becomes_its_subtask() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project()
        let made = try noteWithChecklist(vault, text: "[agent] parent")
        let note = made.note
        let parentBlock = made.block
        let writer = made.writer
        let actions = actions(vault, note: note)
        let parent = try #require(await actions.convert(blockId: parentBlock))
        let child = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: note,
            edit: .insertBlock(
                kind: "checkListItem", afterBlockId: parentBlock, text: "[agent] child", newBlockId: child
            )
        )
        _ = try writer.editBlock(noteId: note, edit: .indent(blockId: child))

        let id = try #require(await actions.convert(blockId: child))

        #expect(try vault.tasks.get(id: id)?.parentId == parent)
    }

    @Test func ticking_a_task_line_completes_then_reopens_the_task() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project()
        let made = try noteWithChecklist(vault)
        let note = made.note
        let block = made.block
        let actions = actions(vault, note: note)
        let id = try #require(await actions.convert(blockId: block))

        #expect(await actions.setDone(true, taskId: id))
        #expect(try vault.tasks.get(id: id)?.isDone == true)
        let line = try vault.vault.notes().blocks(id: note)?.first { $0.id == block }
        #expect(line?.props.first { $0.name == "checked" }?.value == "true")

        #expect(await actions.setDone(false, taskId: id))
        #expect(try vault.tasks.get(id: id)?.isDone == false)
        #expect(actions.inFlight.isEmpty)
    }

    @Test func a_block_that_is_not_a_checklist_item_is_refused_not_failed() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project()
        let made = try noteWithChecklist(vault)
        let note = made.note
        let writer = made.writer
        let paragraph = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: note,
            edit: .insertParagraph(afterBlockId: nil, text: "prose", newBlockId: paragraph)
        )
        let actions = actions(vault, note: note)

        #expect(await actions.convert(blockId: paragraph) == nil)
        #expect(actions.failure == NoteTaskActions.refused)
    }

    @Test func a_write_that_throws_is_reported_as_mapped_copy() async {
        let actions = NoteTaskActions(noteId: "n", tasks: FailingNoteTasks())

        #expect(await actions.setDone(true, taskId: "t") == false)
        #expect(actions.failure != nil)
        #expect(actions.failure?.title != "the core said no")
        actions.dismissFailure()
        #expect(actions.failure == nil)
    }

    @Test func without_a_task_writer_the_bridge_offers_nothing_to_write() {
        let actions = NoteTaskActions(noteId: "n", tasks: nil)
        let editor = NoteEditorViewModel(noteId: "n", editor: nil)
        let bridge = NoteTaskBridge.note(tasks: actions, editor: editor, router: nil) {}

        #expect(!actions.canWrite)
        #expect(bridge.setDone == nil)
        #expect(bridge.convert == nil)
        #expect(bridge.indent == nil)
        #expect(bridge.open == nil)
    }

    @Test func opening_a_task_from_a_note_routes_to_the_tasks_tab() {
        let router = TasksRouter()
        let bridge = NoteTaskBridge.note(
            tasks: NoteTaskActions(noteId: "n", tasks: nil),
            editor: NoteEditorViewModel(noteId: "n", editor: nil),
            router: router
        ) {}

        bridge.open?("abc")

        #expect(router.selectedTab == .tasks)
        #expect(router.path == [.task("abc")])
    }

    @Test func linked_task_copy_names_the_relationship_and_the_state() {
        #expect(TasksCopy.linkedTaskSubtitle(fromThisNote: true, due: nil) == TasksCopy.writtenInThisNote)
        #expect(TasksCopy.linkedTaskSubtitle(fromThisNote: false, due: "Jan 14") == "Mentions this note · due Jan 14")
        #expect(TaskBlockRow.dueLabel("2026-01-14") == "Jan 14")
    }

    // MARK: Search (TP056)

    @Test func search_answers_tasks_from_the_real_index() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] cardamom order", project: project)
        let search = try CoreVaultSearch(vault: vault.vault, executor: .shared)
        let model = VaultSearchViewModel(search: search, debounce: .zero)

        await model.prepare()
        model.run("cardamom")
        await model.settle()

        #expect(model.taskHits.map(\.id) == [id])
        #expect(model.taskHits.first?.kind == "task")
        #expect(model.phase == .results([]))
    }

    @Test func a_failed_task_search_leaves_the_note_results_standing() async {
        let note = SearchResult(id: "n1", title: "Dune", kind: "note", journalDate: nil, score: -1)
        let model = VaultSearchViewModel(
            search: TaskSearchFake(notes: [note], taskFailure: true), debounce: .zero
        )

        model.run("dune")
        await model.settle()

        #expect(model.phase == .results([note]))
        #expect(model.taskHits.isEmpty)
    }

    @Test func clearing_the_query_clears_the_task_hits() async {
        let task = SearchResult(id: "t1", title: "[agent] dune", kind: "task", journalDate: nil, score: -1)
        let model = VaultSearchViewModel(search: TaskSearchFake(tasks: [task]), debounce: .zero)

        model.run("dune")
        await model.settle()
        #expect(model.taskHits == [task])

        model.run("  ")
        #expect(model.taskHits.isEmpty)
        #expect(model.phase == .idle)
    }
}

/// A task surface whose every write throws.
private struct FailingNoteTasks: NoteTaskWriting {
    func complete(taskId: String, localNow: String) async throws {
        throw StorageError.Failed(what: "the core said no")
    }

    func uncomplete(taskId: String) async throws {
        throw StorageError.Failed(what: "the core said no")
    }

    func convertChecklistItem(noteId: String, blockId: String, localNow: String) async throws -> String? {
        throw StorageError.Failed(what: "the core said no")
    }
}

/// Scripted notes and task hits.
private struct TaskSearchFake: VaultSearching {
    var notes: [SearchResult] = []
    var tasks: [SearchResult] = []
    var taskFailure = false

    func notes(query: String, limit: UInt32) async throws -> [SearchResult] { notes }

    func tasks(query: String, limit: UInt32) async throws -> [SearchResult] {
        if taskFailure { throw StorageError.Failed(what: "the task index is locked") }
        return tasks
    }

    func reindex() async throws {}

    func backlinks(noteId: String, order: BacklinkOrder) async throws -> [Backlink] { [] }
    func linksTo(targetId: String, order: BacklinkOrder) async throws -> [BacklinkRow] { [] }
}
