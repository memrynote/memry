import MemryCore
import SwiftUI

// TP052. Desktop's project hub (`pages/project/*`, `use-project-hub.ts`) as
// one scrolling list: the overview (name, description, progress from
// `projectStats`, the overview note), then the project's tasks (the core's
// `all` view scoped to the project; top-level rows with their subtasks), then
// linked notes, files and events with pin and unlink.

private typealias Copy = TasksCopy.Projects

/// TP052 — one project's hub.
struct ProjectHubView: View {
    let projectId: String
    let store: TasksStore

    @Environment(\.dismiss) private var dismiss
    @State private var hub = ProjectHubData()
    @State private var picker: ProjectLinkPickerMode?
    @State private var editing: ProjectEditorTarget?
    @State private var deleting: ProjectItem?

    var body: some View {
        Group {
            if let project = store.project(projectId) {
                content(project)
            } else {
                ContentUnavailableView(Copy.projectNotFound, systemImage: "folder.badge.questionmark")
                    .accessibilityIdentifier("tasks.projectHub.notFound")
            }
        }
        .task(id: ProjectStatsKey(projects: store.projects, tasks: store.ordered)) { await reload() }
    }

    private func content(_ project: ProjectItem) -> some View {
        List {
            if let failure = store.failure {
                ErrorNotice(error: failure, code: nil)
            }
            ProjectHubOverview(
                project: project,
                hub: hub,
                onChooseHome: { picker = .homeNote },
                onClearHome: {
                    Task {
                        await store.setHomeNote(nil, for: project.id)
                        await reload()
                    }
                }
            )
            ProjectHubTasks(store: store, result: hub.tasks)
            ProjectHubLinks(
                project: project,
                hub: hub,
                onAdd: { picker = $0 },
                onAction: { action in Task { await perform(action, in: project.id) } }
            )
        }
        .navigationTitle(project.name)
        .toolbar { toolbar(project) }
        .sheet(item: $picker) { mode in
            ProjectLinkPicker(store: store, mode: mode, excluded: mode == .homeNote ? [] : hub.linkedIds) { item in
                Task {
                    if mode == .homeNote {
                        await store.setHomeNote(item.id, for: project.id)
                    } else {
                        await store.link(item, to: project.id)
                    }
                    await reload()
                }
            }
        }
        .sheet(item: $editing) { target in
            ProjectEditorSheet(store: store, projectId: target.projectId) { dismiss() }
        }
        .projectDeleteDialog($deleting, store: store) { dismiss() }
        .refreshable {
            await store.sync()
            await reload()
        }
        .accessibilityIdentifier("tasks.projectHub")
    }

    @ToolbarContentBuilder
    private func toolbar(_ project: ProjectItem) -> some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button(Copy.editProject, systemImage: "pencil") {
                    editing = ProjectEditorTarget(projectId: project.id)
                }
                .accessibilityIdentifier("tasks.projectHub.edit")
                if !project.isInbox {
                    let archived = project.archivedAt != nil
                    Button(
                        archived ? Copy.unarchiveProject : Copy.archiveProject,
                        systemImage: archived ? "tray.and.arrow.up" : "archivebox"
                    ) {
                        Task { await store.setProjectArchived(project.id, archived: !archived) }
                    }
                    .accessibilityIdentifier("tasks.projectHub.archive")
                    Button(Copy.deleteProject, systemImage: "trash", role: .destructive) { deleting = project }
                        .accessibilityIdentifier("tasks.projectHub.delete")
                }
            } label: {
                Label(Copy.projectActions, systemImage: "ellipsis.circle")
            }
            .accessibilityIdentifier("tasks.projectHub.menu")
        }
    }

    private func perform(_ action: ProjectHubLinkAction, in projectId: String) async {
        switch action {
        case let .unlink(link): await store.unlink(link, from: projectId)
        case let .pin(link, pinned): await store.setPinned(link, pinned: pinned, in: projectId)
        }
        await reload()
    }

    private func reload() async {
        guard store.project(projectId) != nil else { return }
        async let stats = store.projectStatsById()
        async let links = store.projectLinks(projectId)
        async let tasks = store.projectTasks(projectId)
        async let titles = store.linkableTitles()
        hub = await ProjectHubData(
            stats: stats[projectId],
            links: links ?? hub.links,
            titles: titles,
            tasks: tasks ?? hub.tasks,
            homeNoteId: store.project(projectId)?.homeNoteId
        )
    }
}

/// What the hub shows, read in one pass.
struct ProjectHubData: Equatable {
    var stats: ProjectStats?
    var links: [ProjectLinkItem] = []
    var titles: [String: RelatedItemRecord] = [:]
    var tasks: TaskViewResult?
    var homeNoteId: String?

    var linkedIds: Set<String> { Set(links.map(\.itemId)) }

    func links(of kind: ProjectLinkKind) -> [ProjectLinkItem] {
        links.filter { ProjectLinkKind(itemType: $0.itemType) == kind }
    }

    /// Desktop's rail pins notes only.
    var pinnedNotes: [ProjectLinkItem] {
        links(of: .note).filter(\.pinned)
    }
}

enum ProjectHubLinkAction {
    case unlink(ProjectLinkItem)
    case pin(ProjectLinkItem, Bool)
}
