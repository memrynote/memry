import MemryCore
import SwiftUI

// TP046, #2868. "Move under…" (desktop's `subtask-tree/move-under-dialog.tsx`):
// the task's project as the same tree the list draws, from the core
// (`Tasks::move_under_places`). The task's own branch and any place the
// device-local `tasks.nestedSubtasks` gate refuses show dimmed and cannot be
// picked. A search lists the matches flat, each with its path. Below the tree,
// the top-level tasks of other projects: picking one moves this task there
// first (the core keeps a subtask in its parent's project).

/// TP046 — pick where a task goes in the tree.
struct ParentPickerSheet: View {
    let task: TaskItem
    let store: TasksStore

    @State private var query = ""
    @State private var places: [TaskPlace] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(TasksCopy.parentPickerTitle)
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, prompt: TasksCopy.parentPickerSearch)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(role: .close) { close() }
                            .accessibilityIdentifier("tasks.parentPicker.cancel")
                    }
                }
        }
        .accessibilityIdentifier("tasks.parentPicker")
        .task(id: task.id) { places = await store.moveUnderPlaces(for: task) }
    }

    @ViewBuilder private var content: some View {
        let tree = matching(places)
        let other = store.otherProjectParents(for: task, matching: query)
        if tree.isEmpty, other.isEmpty {
            ContentUnavailableView(TasksCopy.treeMoveUnderEmpty, systemImage: "list.bullet.indent")
        } else {
            List {
                Section {
                    Text(TasksCopy.parentPickerMessage(task.title))
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                if !tree.isEmpty {
                    Section(TasksCopy.parentPickerSameProjectHeader(store.project(task.projectId)?.name)) {
                        ForEach(tree, id: \.taskId) { place($0) }
                    }
                }
                if !other.isEmpty {
                    Section(TasksCopy.parentPickerOtherProjects) {
                        ForEach(other, id: \.id) { otherProject($0) }
                    }
                }
            }
        }
    }

    /// The tree, or the matches flat while searching.
    private func matching(_ places: [TaskPlace]) -> [TaskPlace] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return places }
        return places.filter { store.items[$0.taskId]?.title.localizedCaseInsensitiveContains(needle) == true }
    }

    @ViewBuilder private func place(_ place: TaskPlace) -> some View {
        if let candidate = store.items[place.taskId] {
            let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
            Button {
                close()
                let task = task
                Task { await store.moveUnder(task, parentId: candidate.id, title: candidate.title) }
            } label: {
                ParentCandidateRow(
                    candidate: candidate,
                    project: nil,
                    note: place.taskId == task.id ? TasksCopy.treeThisTask : searching ? path(place) : nil
                )
                .padding(.leading, searching ? 0 : CGFloat(place.depth) * Tokens.Space.section)
            }
            .buttonStyle(.plain)
            .disabled(!place.allowed)
            .opacity(place.allowed ? 1 : 0.4)
            .accessibilityIdentifier("tasks.parentPicker.candidate.\(candidate.id)")
        }
    }

    private func path(_ place: TaskPlace) -> String? {
        let titles = place.pathIds.compactMap { store.items[$0]?.title }
        return titles.isEmpty ? nil : titles.joined(separator: " › ")
    }

    private func otherProject(_ candidate: TaskItem) -> some View {
        Button {
            close()
            let task = task
            Task { await store.makeSubtask(task, of: candidate) }
        } label: {
            ParentCandidateRow(candidate: candidate, project: store.project(candidate.projectId), note: nil)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tasks.parentPicker.candidate.\(candidate.id)")
    }

    private func close() {
        store.scratch[TasksStore.parentPickerScratchKey] = nil
        dismiss()
    }
}

/// A potential parent: its circle, title, and its path or project.
private struct ParentCandidateRow: View {
    let candidate: TaskItem
    let project: ProjectItem?
    let note: String?

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            TaskStatusIcon(statusType: candidate.statusType, isDone: candidate.isDone)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(candidate.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(candidate.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                    .strikethrough(candidate.isDone)
                if let note {
                    Text(note)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let project {
                TaskProjectChip(name: project.name, color: project.color)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
