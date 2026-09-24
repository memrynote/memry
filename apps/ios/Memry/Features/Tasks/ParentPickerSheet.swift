import MemryCore
import SwiftUI

// TP046. "Make subtask of…" (`dialogs/parent-picker-dialog.tsx`): top-level
// tasks, the task's own project first, then the other projects, with a title
// search. Picking a task in another project moves this one there first (the
// core keeps a subtask in its parent's project).

/// TP046 — pick a parent task (same project / other projects, search).
struct ParentPickerSheet: View {
    let task: TaskItem
    let store: TasksStore

    @State private var query = ""
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
    }

    @ViewBuilder private var content: some View {
        let candidates = store.parentCandidates(for: task, matching: query)
        let same = candidates.filter { $0.projectId == task.projectId }
        let other = candidates.filter { $0.projectId != task.projectId }
        if !store.subtasks(of: task.id).isEmpty {
            ContentUnavailableView(TasksCopy.parentPickerHasSubtasks, systemImage: "list.bullet.indent")
        } else if candidates.isEmpty {
            ContentUnavailableView(
                query.isEmpty ? TasksCopy.parentPickerNoCandidates : TasksCopy.parentPickerNoMatches,
                systemImage: "folder"
            )
        } else {
            List {
                Section {
                    Text(TasksCopy.parentPickerMessage(task.title))
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                if !same.isEmpty {
                    Section(TasksCopy.parentPickerSameProjectHeader(store.project(task.projectId)?.name)) {
                        ForEach(same, id: \.id) { row($0) }
                    }
                }
                if !other.isEmpty {
                    Section(TasksCopy.parentPickerOtherProjects) {
                        ForEach(other, id: \.id) { row($0) }
                    }
                }
            }
        }
    }

    private func row(_ candidate: TaskItem) -> some View {
        Button {
            let chosen = candidate
            close()
            Task { await store.makeSubtask(task, of: chosen) }
        } label: {
            ParentCandidateRow(candidate: candidate, project: store.project(candidate.projectId))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tasks.parentPicker.candidate.\(candidate.id)")
    }

    private func close() {
        store.scratch[TasksStore.parentPickerScratchKey] = nil
        dismiss()
    }
}

/// A potential parent: its circle, title and project.
private struct ParentCandidateRow: View {
    let candidate: TaskItem
    let project: ProjectItem?

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            TaskStatusIcon(statusType: candidate.statusType, isDone: candidate.isDone)
                .accessibilityHidden(true)
            Text(candidate.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(candidate.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .strikethrough(candidate.isDone)
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
