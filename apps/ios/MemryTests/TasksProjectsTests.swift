import Foundation
import MemryCore
import Testing

@testable import Memry

// TP052: the project editor's form rules (desktop `validateProject`,
// `canDeleteStatus`, `hasFormChanged`), the draft it saves, and the project
// writes and hub reads over a real scratch vault.

@MainActor
@Suite("Tasks projects", .serialized)
struct TasksProjectsTests {
    // MARK: Editor model

    @Test func a_new_project_starts_with_desktops_defaults_and_no_changes() {
        let model = ProjectEditorModel(project: nil)
        #expect(!model.isEditing)
        #expect(!model.hasChanges)
        #expect(model.form.color == ProjectPalette.defaultProjectColor)
        #expect(model.form.icon == ProjectIconValue.defaultIcon)
        #expect(model.form.statuses.map(\.statusType) == ["todo", "in_progress", "done"])
        #expect(model.nameError == TasksCopy.Projects.nameRequired)
        #expect(!model.isValid)
    }

    @Test func validation_follows_desktops_editor_rules() {
        let model = ProjectEditorModel(project: nil)
        model.form.name = String(repeating: "a", count: 51)
        #expect(model.nameError == TasksCopy.Projects.nameTooLong)
        model.form.name = "Agent Test Rules"
        #expect(model.nameError == nil)
        #expect(model.isValid)

        model.form.statuses[1].name = "to do"
        #expect(model.statusesError == TasksCopy.Projects.statusNamesUnique)
        model.form.statuses[1].name = " "
        #expect(model.statusesError == TasksCopy.Projects.statusNameRequired)
        model.form.statuses[1].name = "Doing"

        model.form.statuses[2].statusType = "in_progress"
        #expect(model.statusesError == TasksCopy.Projects.needsDoneForCompletedTasks)
        model.form.statuses[2].statusType = "done"
        model.form.statuses[0].statusType = "in_progress"
        #expect(model.statusesError == TasksCopy.Projects.needsTodoForNewTasks)
        model.form.statuses[0].statusType = "todo"

        model.form.statuses.removeLast(2)
        #expect(model.statusesError == TasksCopy.Projects.minStatuses)
    }

    @Test func a_status_that_must_stay_cannot_be_deleted() {
        let model = ProjectEditorModel(project: nil)
        let todo = model.form.statuses[0]
        let doing = model.form.statuses[1]
        #expect(model.deleteBlocker(todo) == TasksCopy.Projects.needsTodoStatus)
        #expect(model.deleteBlocker(doing) == nil)
        model.deleteStatus(todo)
        #expect(model.form.statuses.count == 3)
        model.deleteStatus(doing)
        #expect(model.form.statuses.count == 2)
        #expect(model.deleteBlocker(model.form.statuses[0]) == TasksCopy.Projects.minStatuses)
    }

    @Test func moving_and_reverting_tracks_unsaved_changes() {
        let model = ProjectEditorModel(project: nil)
        let first = model.form.statuses[0]
        model.moveStatus(first, by: 1)
        #expect(model.form.statuses[1] == first)
        #expect(model.hasChanges)
        model.moveStatus(first, by: -1)
        #expect(!model.hasChanges)
        model.moveStatus(first, by: -1)
        #expect(model.form.statuses[0] == first)
    }

    @Test func inputs_are_clamped_to_desktops_max_lengths() {
        let model = ProjectEditorModel(project: nil)
        model.form.name = String(repeating: "n", count: 80)
        model.form.description = String(repeating: "d", count: 300)
        model.form.statuses[0].name = String(repeating: "s", count: 40)
        model.clampInputs()
        #expect(model.form.name.count == ProjectEditorModel.maxNameLength)
        #expect(model.form.description.count == ProjectEditorModel.maxDescriptionLength)
        #expect(model.form.statuses[0].name.count == ProjectEditorModel.maxStatusNameLength)
    }

    @Test func the_icon_field_keeps_emoji_only() {
        #expect(ProjectIconValue.sanitize("📚") == "📚")
        #expect(ProjectIconValue.sanitize("ab") == nil)
        #expect(ProjectIconValue.emoji("Folder") == nil)
        #expect(ProjectIconValue.emoji("icon:Book") == nil)
        #expect(ProjectIconValue.emoji("🚀") == "🚀")
    }

    @Test func the_palette_is_desktops() {
        #expect(ProjectPalette.swatches.count == 10)
        #expect(ProjectPalette.swatch(for: "#6366F1")?.id == "indigo")
        #expect(TasksCopy.Projects.colorName("teal") == "Teal")
    }

    // MARK: Store over the core

    @Test func create_sends_the_form_statuses_and_update_leaves_untouched_ones() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        let model = ProjectEditorModel(project: nil)
        model.form.name = "Agent Test Create"
        model.form.icon = "🚀"
        #expect(model.draft.statuses?.count == 3)
        #expect(await model.save(in: vault.store))
        let created = try #require(vault.store.projects.first { $0.name == "Agent Test Create" })
        #expect(created.icon == "🚀")
        #expect(created.statuses.count == 3)
        #expect(vault.store.toast == TasksCopy.Projects.projectCreated)

        let edit = ProjectEditorModel(project: created)
        #expect(!edit.hasChanges)
        edit.form.description = "About"
        #expect(edit.draft.statuses == nil)
        edit.addStatus()
        edit.form.statuses[3].name = "Review"
        edit.form.statuses[3].statusType = "in_progress"
        #expect(edit.draft.statuses?.map(\.order) == [0, 1, 2, 3])
        #expect(await edit.save(in: vault.store))
        let updated = try #require(vault.store.project(created.id))
        #expect(updated.description == "About")
        #expect(updated.statuses.map(\.name).contains("Review"))
        #expect(vault.store.toast == TasksCopy.Projects.projectUpdated)
    }

    @Test func archive_reorder_and_delete_go_through_the_core() async throws {
        let vault = try TasksTestVault()
        let first = try vault.project("Agent Test One")
        let second = try vault.project("Agent Test Two")
        _ = try vault.task("[agent] in two", project: second)
        await vault.store.load()

        await vault.store.reorderProjects([second, first])
        #expect(vault.store.activeProjects.map(\.id) == [second, first])

        await vault.store.setProjectArchived(first, archived: true)
        #expect(vault.store.archivedProjects.map(\.id) == [first])
        #expect(!vault.store.activeProjects.contains { $0.id == first })

        let stats = await vault.store.projectStatsById()
        #expect(stats[second]?.taskCount == 1)

        #expect(await vault.store.deleteProject(second, moveTasksToInbox: false))
        #expect(vault.store.project(second) == nil)
        #expect(vault.store.ordered.isEmpty)
        #expect(vault.store.toast == TasksCopy.Projects.projectDeleted)
    }

    @Test func the_hub_links_pins_and_picks_an_overview_note() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Hub")
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Test Note", folderPath: nil)
        let taskId = try vault.task("[agent] hub task", project: project)
        await vault.store.load()

        let found = await vault.store.searchLinkable("Agent Test Note")
        let note = try #require(found.first { $0.id == noteId })
        #expect(ProjectLinkPickerMode.note.admits(note))
        #expect(!ProjectLinkPickerMode.file.admits(note))

        await vault.store.link(note, to: project)
        var links = try #require(await vault.store.projectLinks(project))
        #expect(links.map(\.itemId) == [noteId])
        #expect(ProjectLinkKind(itemType: links[0].itemType) == .note)

        await vault.store.setPinned(links[0], pinned: true, in: project)
        links = try #require(await vault.store.projectLinks(project))
        #expect(links[0].pinned)
        let titles = await vault.store.linkableTitles()
        #expect(titles[noteId]?.title == "Agent Test Note")

        await vault.store.setHomeNote(noteId, for: project)
        #expect(vault.store.project(project)?.homeNoteId == noteId)
        await vault.store.setHomeNote(nil, for: project)
        #expect(vault.store.project(project)?.homeNoteId == nil)

        await vault.store.unlink(links[0], from: project)
        #expect(await vault.store.projectLinks(project)?.isEmpty == true)

        let tasks = await vault.store.projectTasks(project)
        #expect(tasks?.taskIds == [taskId])
    }
}
