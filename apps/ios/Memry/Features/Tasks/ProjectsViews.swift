import MemryCore
import SwiftUI

// TP052. Every project: the active ones in `position` order (reorderable,
// `reorderProjects`), then the archived ones; each row shows its open and
// overdue counts (`projectStats`) and opens the hub. Swipe and context menu
// edit, archive/unarchive (`setProjectArchived`) and delete; the Inbox can
// do neither of the last two (desktop: `!project.isDefault`).

private typealias Copy = TasksCopy.Projects

/// TP052 — every project.
struct ProjectsListView: View {
    let store: TasksStore

    @State private var stats: [String: ProjectStats] = [:]
    @State private var editing: ProjectEditorTarget?
    @State private var deleting: ProjectItem?
    @State private var editMode: EditMode = .inactive

    var body: some View {
        List {
            if let failure = store.failure {
                ErrorNotice(error: failure, code: nil)
            }
            Section {
                ForEach(store.activeProjects, id: \.id) { project in
                    row(project)
                }
                .onMove { source, destination in
                    Task { await store.moveProjects(from: source, to: destination) }
                }
            }
            if !store.archivedProjects.isEmpty {
                Section(Copy.archivedProjects) {
                    ForEach(store.archivedProjects, id: \.id) { project in
                        row(project)
                    }
                    .moveDisabled(true)
                }
            }
        }
        .overlay {
            if store.projects.isEmpty, !store.isLoading {
                ContentUnavailableView(Copy.noProjects, systemImage: "folder")
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle(Copy.projectsTitle)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    editing = ProjectEditorTarget(projectId: nil)
                } label: {
                    Label(Copy.newProject, systemImage: "plus")
                }
                .accessibilityIdentifier("tasks.projects.new")
            }
            ToolbarItem(placement: .secondaryAction) {
                Button(editMode.isEditing ? Copy.doneReordering : Copy.reorderProjects) {
                    editMode = editMode.isEditing ? .inactive : .active
                }
                .accessibilityIdentifier("tasks.projects.reorder")
            }
        }
        .sheet(item: $editing) { target in
            ProjectEditorSheet(store: store, projectId: target.projectId)
        }
        .projectDeleteDialog($deleting, store: store)
        .task(id: ProjectStatsKey(projects: store.projects, tasks: store.ordered)) {
            stats = await store.projectStatsById()
        }
        .refreshable { await store.sync() }
    }

    private func row(_ project: ProjectItem) -> some View {
        NavigationLink(value: TasksRoute.project(project.id)) {
            ProjectListRow(project: project, stats: stats[project.id])
        }
        .accessibilityIdentifier("tasks.projects.row.\(project.id)")
        .swipeActions(edge: .trailing) {
            if !project.isInbox {
                Button(Copy.deleteProject, systemImage: "trash", role: .destructive) { deleting = project }
                archiveButton(project)
            }
        }
        .swipeActions(edge: .leading) {
            Button(Copy.editProject, systemImage: "pencil") {
                editing = ProjectEditorTarget(projectId: project.id)
            }
        }
        .contextMenu {
            Button(Copy.editProject, systemImage: "pencil") {
                editing = ProjectEditorTarget(projectId: project.id)
            }
            if !project.isInbox {
                archiveButton(project)
                Button(Copy.deleteProject, systemImage: "trash", role: .destructive) { deleting = project }
            }
        }
        .accessibilityActions {
            Button(Copy.editProject) { editing = ProjectEditorTarget(projectId: project.id) }
            if !project.isInbox {
                archiveButton(project)
                Button(Copy.deleteProject) { deleting = project }
            }
            if project.archivedAt == nil { moveActions(project) }
        }
    }

    private func archiveButton(_ project: ProjectItem) -> some View {
        let archived = project.archivedAt != nil
        return Button(
            archived ? Copy.unarchiveProject : Copy.archiveProject,
            systemImage: archived ? "tray.and.arrow.up" : "archivebox"
        ) {
            Task { await store.setProjectArchived(project.id, archived: !archived) }
        }
    }

    @ViewBuilder
    private func moveActions(_ project: ProjectItem) -> some View {
        let ids = store.activeProjects.map(\.id)
        if let index = ids.firstIndex(of: project.id) {
            if index > 0 {
                Button(Copy.moveUp) {
                    Task { await store.moveProjects(from: IndexSet(integer: index), to: index - 1) }
                }
            }
            if index < ids.count - 1 {
                Button(Copy.moveDown) {
                    Task { await store.moveProjects(from: IndexSet(integer: index), to: index + 2) }
                }
            }
        }
    }
}

/// Which project the editor sheet opens; `nil` creates one.
struct ProjectEditorTarget: Identifiable, Hashable {
    let projectId: String?
    var id: String { projectId ?? "new" }
}

/// Reloads the counts whenever a project or a task changes.
struct ProjectStatsKey: Equatable {
    let projects: [ProjectItem]
    let tasks: [TaskItem]
}

private struct ProjectListRow: View {
    let project: ProjectItem
    let stats: ProjectStats?

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            ProjectIconView(icon: project.icon, color: project.color)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(project.name)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(
                        project.archivedAt == nil ? Tokens.Text.primary.color : Tokens.Text.secondary.color
                    )
                if let stats {
                    Text(summary(stats))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(
                            stats.overdueCount > 0 ? Tokens.Task.dueOverdue.color : Tokens.Text.secondary.color
                        )
                }
            }
            Spacer(minLength: 0)
            if project.isInbox {
                Image(systemName: "lock")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(Copy.inboxLocked)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .combine)
    }

    private func summary(_ stats: ProjectStats) -> String {
        let open = Int(stats.taskCount) - Int(stats.completedCount)
        return Copy.projectSummary(open: max(open, 0), overdue: Int(stats.overdueCount))
    }
}
