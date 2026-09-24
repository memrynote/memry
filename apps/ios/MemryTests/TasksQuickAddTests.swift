import Foundation
import MemryCore
import Testing

@testable import Memry

// TP042: quick add (trigger, ghost, project resolution, submit) and the Add
// Task sheet's draft, over the real core.

@MainActor
@Suite("Tasks quick add", .serialized)
struct TasksQuickAddTests {
    // MARK: Trigger and ghost

    @Test func the_trigger_is_the_run_the_caret_ends_in() {
        #expect(QuickAddTrigger.detect("buy #gro") == QuickAddTrigger(kind: .tag, query: "gro", start: 4))
        #expect(QuickAddTrigger.detect("buy +wo")?.kind == .project)
        #expect(QuickAddTrigger.detect("buy !hi")?.kind == .priority)
        let nextMonday = QuickAddTrigger(kind: .datePhrase, query: "next mon", start: 5)
        #expect(QuickAddTrigger.detect("call @next mon") == nextMonday)
        #expect(QuickAddTrigger.detect("gym every wee") == QuickAddTrigger(kind: .repeat, query: "every wee", start: 4))
        #expect(QuickAddTrigger.detect("read [[Q3 #la")?.kind == .noteLink)
        #expect(QuickAddTrigger.detect("read [[Q3]] now") == nil)
        #expect(QuickAddTrigger.detect("mail a@b") == nil)
    }

    @Test func the_ghost_finishes_dates_and_repeats_from_the_core() {
        let now = "2026-01-14T12:00:00"
        let date = QuickAddGhost.predict("call @tomo", trigger: QuickAddTrigger.detect("call @tomo"), now: now)
        #expect(date?.text.lowercased() == "@tomorrow")
        #expect(date?.remainder == "rrow")
        #expect(date?.accept(in: "call @tomo") == "call @Tomorrow ")

        let cadence = QuickAddGhost.predict("gym every wee", trigger: QuickAddTrigger.detect("gym every wee"), now: now)
        #expect(cadence?.text == "every weekday")
        #expect(QuickAddGhost.predict("plain words", trigger: nil, now: now) == nil)
    }

    @Test func the_date_hint_resolves_through_the_core() {
        let now = "2026-01-14T12:00:00"
        let hint = QuickAddDateHint.resolve(trigger: QuickAddTrigger.detect("x @tomorrow"), now: now, previous: nil)
        #expect(hint?.date == "2026-01-15")
        #expect(QuickAddDateHint.resolve(trigger: QuickAddTrigger.detect("x #tag"), now: now, previous: hint) == nil)
    }

    // MARK: Project resolution

    @Test func the_project_chain_follows_desktop() async throws {
        let vault = try TasksTestVault()
        let first = try vault.project("Agent Test First")
        let second = try vault.project("Agent Test Second")
        await vault.store.load()
        let store = vault.store

        #expect(store.resolveProjectId(parsed: second, preferred: first) == second)
        #expect(store.resolveProjectId(parsed: nil, preferred: second) == second)
        store.state.projectId = second
        #expect(store.resolveProjectId(parsed: nil) == second)
        store.state.projectId = "gone"
        #expect(store.resolveProjectId(parsed: nil, preferred: "also-gone") != nil)
        #expect([first, second].contains(store.resolveProjectId(parsed: nil) ?? ""))
    }

    // MARK: Submit

    @Test func submit_creates_what_the_core_parsed() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Errands")
        await vault.store.load()

        let id = await vault.store.submitQuickAdd(
            "[agent] Buy milk @tomorrow 5pm !high +agent-test-errands #errand",
            preferredProjectId: nil,
            picks: QuickAddPicks()
        )
        let created = try #require(vault.store.items[id ?? ""])
        #expect(created.title == "[agent] Buy milk")
        #expect(created.projectId == project)
        #expect(created.dueDate == "2026-01-15")
        #expect(created.dueTime == "17:00")
        #expect(created.priority == 3)
        #expect(created.tags == ["errand"])
        #expect(vault.store.undoable?.message == TasksCopy.created)
    }

    @Test func submit_on_today_defaults_the_due_date_and_repeats() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project()
        await vault.store.load()
        await vault.store.update { $0.tab = .today }

        let id = await vault.store.submitQuickAdd(
            "[agent] Stretch every day", preferredProjectId: nil, picks: QuickAddPicks()
        )
        let created = try #require(vault.store.items[id ?? ""])
        #expect(created.dueDate == "2026-01-14")
        #expect(created.repeat?.frequency == "daily")
    }

    @Test func submit_ignores_token_only_text() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project()
        await vault.store.load()
        let id = await vault.store.submitQuickAdd("!high @today", preferredProjectId: nil, picks: QuickAddPicks())
        #expect(id == nil)
        #expect(vault.store.items.isEmpty)
    }

    @Test func picked_notes_and_projects_win_over_rereading_the_text() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project("Agent Test Home")
        let picked = try vault.project("Agent Test Picked")
        await vault.store.load()
        var picks = QuickAddPicks()
        picks.projects["agent-test-picked"] = picked
        picks.notes["plan"] = "note-plan"

        let id = await vault.store.submitQuickAdd(
            "[agent] Draft +agent-test-picked [[Plan]]", preferredProjectId: nil, picks: picks
        )
        let created = try #require(vault.store.items[id ?? ""])
        #expect(created.projectId == picked)
        #expect(created.linkedNoteIds == ["note-plan"])
    }

    @Test func tag_suggestions_are_commonest_first() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        await vault.store.load()
        for (title, tags) in [("[agent] a", ["home", "work"]), ("[agent] b", ["work"])] {
            var draft = TaskDraft()
            draft.title = title
            draft.projectId = project
            draft.tags = tags
            await vault.store.createTask(draft)
        }
        #expect(vault.store.tagSuggestions("") == ["work", "home"])
        #expect(vault.store.tagSuggestions("ho") == ["home"])
    }

    // MARK: Add Task sheet

    @Test func the_sheet_draft_creates_every_field() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        await vault.store.load()

        var draft = vault.store.newTaskDraft(title: "[agent] child", parentId: parent, projectId: nil)
        #expect(draft.projectId == project)
        draft.description = "  notes  "
        draft.priority = 4
        draft.dueDate = "2026-01-20"
        draft.dueTime = "09:30"
        draft.startDate = "2026-01-16"
        draft.tags = ["deep"]
        let id = await vault.store.createTask(draft)
        let created = try #require(vault.store.items[id ?? ""])
        #expect(created.parentId == parent)
        #expect(created.description == "notes")
        #expect(created.priority == 4)
        #expect(created.dueDate == "2026-01-20")
        #expect(created.dueTime == "09:30")
        #expect(created.startDate == "2026-01-16")
        #expect(created.tags == ["deep"])
        #expect(created.statusType == "todo")
    }

    @Test func create_another_keeps_project_parent_and_due() {
        var draft = TaskDraft()
        draft.title = "x"
        draft.projectId = "p"
        draft.parentId = "t"
        draft.dueDate = "2026-01-20"
        draft.dueTime = "09:00"
        draft.priority = 2
        draft.tags = ["a"]
        draft.resetForAnother()
        #expect(draft.title.isEmpty)
        #expect(draft.projectId == "p")
        #expect(draft.parentId == "t")
        #expect(draft.dueDate == "2026-01-20")
        #expect(draft.dueTime == nil)
        #expect(draft.priority == 0)
        #expect(draft.tags.isEmpty)
    }

    @Test func the_sheet_starts_due_today_on_the_today_tab() async throws {
        let vault = try TasksTestVault()
        _ = try vault.project()
        await vault.store.load()
        await vault.store.update { $0.tab = .today }
        let draft = vault.store.newTaskDraft(title: "", parentId: nil, projectId: nil)
        #expect(draft.dueDate == "2026-01-14")
        #expect(draft.projectId != nil)
    }
}
