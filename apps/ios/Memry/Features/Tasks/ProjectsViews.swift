import MemryCore
import SwiftUI

// TP052, redesigned (RD17, Paper "Projects"). Every project: the active
// ones in `position` order, each a progress ring in its colour (the Inbox a
// tray; an emoji icon shows in the hub and the editor), its name and its
// open count; then "Archived N", folded. Tap opens
// the hub. Swipe and long press edit, archive/unarchive
// (`setProjectArchived`) and delete; the Inbox can do neither of the last two
// (desktop: `!project.isDefault`). Reordering (`reorderProjects`) starts from
// a row's long-press menu and ends with the checkmark.

private typealias Copy = TasksCopy.Projects

/// TP052 — every project.
struct ProjectsListView: View {
    let store: TasksStore

    @State private var stats: [String: ProjectStats] = [:]
    @State private var editing: ProjectEditorTarget?
    @State private var deleting: ProjectItem?
    @State private var editMode: EditMode = .inactive
    @State private var showsArchived = false

    var body: some View {
        List {
            Group {
                if let failure = store.failure {
                    ErrorNotice(error: failure, code: nil)
                }
                ForEach(store.activeProjects, id: \.id) { project in
                    row(project)
                }
                .onMove { source, destination in
                    Task { await store.moveProjects(from: source, to: destination) }
                }
                if !store.archivedProjects.isEmpty, !editMode.isEditing {
                    archivedHeader
                    if showsArchived {
                        ForEach(store.archivedProjects, id: \.id) { project in
                            row(project)
                        }
                        .moveDisabled(true)
                    }
                }
            }
            // Plain-list cells default to the system background (black in dark),
            // not the canvas.
            .listRowBackground(Tokens.Canvas.background.color)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .overlay {
            if store.projects.isEmpty, !store.isLoading {
                ContentUnavailableView(Copy.noProjects, systemImage: "folder")
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle(Copy.projectsTitle)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if editMode.isEditing {
                    TaskSheetConfirmButton(label: Copy.doneReordering) { editMode = .inactive }
                        .accessibilityIdentifier("tasks.projects.reorder")
                } else {
                    Button {
                        editing = ProjectEditorTarget(projectId: nil)
                    } label: {
                        Label(Copy.newProject, systemImage: "plus")
                    }
                    .accessibilityIdentifier("tasks.projects.new")
                }
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

    /// "› Archived 2": folds the archived projects away (Paper 17).
    private var archivedHeader: some View {
        Button {
            showsArchived.toggle()
        } label: {
            HStack(spacing: Tokens.Space.small) {
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .rotationEffect(.degrees(showsArchived ? 90 : 0))
                    .accessibilityHidden(true)
                Text(Copy.archivedProjects)
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                Text("\(store.archivedProjects.count)")
                    .font(Tokens.Typography.caption.font.monospacedDigit())
                Spacer(minLength: 0)
            }
            .foregroundStyle(Tokens.Text.tertiary.color)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .calmAnimation(.fast, value: showsArchived)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge))
        .moveDisabled(true)
        .accessibilityLabel(Copy.archivedAccessibility(store.archivedProjects.count, collapsed: !showsArchived))
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("tasks.projects.archived")
    }

    private func row(_ project: ProjectItem) -> some View {
        NavigationLink(value: TasksRoute.project(project.id)) {
            ProjectListRow(project: project, stats: stats[project.id])
        }
        .navigationLinkIndicatorVisibility(.hidden)
        .listRowInsets(EdgeInsets(
            top: Tokens.Space.tight, leading: TaskLayout.edge, bottom: Tokens.Space.tight, trailing: TaskLayout.edge
        ))
        .alignmentGuide(.listRowSeparatorLeading) { _ in TaskLayout.lane + Tokens.Space.medium }
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
            if project.archivedAt == nil, store.activeProjects.count > 1 {
                Button(Copy.reorderProjects, systemImage: "arrow.up.arrow.down") { editMode = .active }
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

/// Paper 17: ring (or the Inbox tray), name, open count; the count turns
/// red when any are overdue.
private struct ProjectListRow: View {
    let project: ProjectItem
    let stats: ProjectStats?

    private var open: Int {
        guard let stats else { return 0 }
        return max(Int(stats.taskCount) - Int(stats.completedCount), 0)
    }

    private var overdue: Int { Int(stats?.overdueCount ?? 0) }

    private var fraction: Double {
        guard let stats, stats.taskCount > 0 else { return 0 }
        return Double(stats.completedCount) / Double(stats.taskCount)
    }

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Group {
                if project.isInbox {
                    Image(systemName: "tray")
                        .foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    TaskProgressRing(
                        fraction: fraction,
                        color: Tokens.Palette.color(project.color),
                        font: Tokens.Typography.body.font
                    )
                }
            }
            .font(Tokens.Typography.body.font)
            .frame(width: TaskLayout.lane)
            .accessibilityHidden(true)
            Text(project.name)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(
                    project.archivedAt == nil ? Tokens.Text.primary.color : Tokens.Text.tertiary.color
                )
            Spacer(minLength: Tokens.Space.small)
            if stats != nil {
                Text("\(open)")
                    .font(Tokens.Typography.supporting.font.monospacedDigit())
                    .foregroundStyle(overdue > 0 ? Tokens.Task.dueOverdue.color : Tokens.Text.tertiary.color)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(project.name)
        .accessibilityValue(stats.map { _ in Copy.projectSummary(open: open, overdue: overdue) } ?? "")
        .accessibilityHint(project.isInbox ? Copy.inboxLocked : "")
    }
}
