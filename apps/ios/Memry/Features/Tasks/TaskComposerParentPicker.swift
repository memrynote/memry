import MemryCore
import SwiftUI

// RD03. The composer's "Parent task" picker (TP042's Add Task sheet picker,
// kept when the sheet was removed): open top-level tasks, this project's
// first, then the other projects', with a title search. Picking a parent in
// another project moves the draft there (a subtask lives in its parent's
// project, TP020).

/// Picks the task a new task is filed under.
struct AddTaskParentPicker: View {
    let store: TasksStore
    let projectId: String?
    let selection: String?
    let onPick: (TaskItem?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                Button { onPick(nil) } label: { choice(TasksCopy.noParent, selected: selection == nil) }
                    .accessibilityIdentifier("tasks.addTask.parent.none")
                let here = candidates.filter { $0.projectId == projectId }
                let elsewhere = candidates.filter { $0.projectId != projectId }
                section(TasksCopy.parentThisProject, here, showProject: false)
                section(TasksCopy.parentOtherProjects, elsewhere, showProject: true)
            }
            .searchable(text: $query, prompt: TasksCopy.searchTasks)
            .navigationTitle(TasksCopy.fieldParent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("tasks.addTask.parentPicker")
    }

    private var candidates: [TaskItem] {
        let lower = query.lowercased()
        return store.parentCandidates().filter { lower.isEmpty || $0.title.lowercased().contains(lower) }
    }

    @ViewBuilder
    private func section(_ title: String, _ tasks: [TaskItem], showProject: Bool) -> some View {
        if !tasks.isEmpty {
            Section(title) {
                ForEach(tasks, id: \.id) { task in
                    Button { onPick(task) } label: {
                        choice(task.title, selected: selection == task.id, project: showProject ? task.projectId : nil)
                    }
                    .accessibilityIdentifier("tasks.addTask.parent.\(task.id)")
                }
            }
        }
    }

    private func choice(_ title: String, selected: Bool, project: String? = nil) -> some View {
        HStack(spacing: Tokens.Space.small) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                if let project = store.project(project) {
                    TaskProjectChip(name: project.name, color: project.color)
                }
            }
            Spacer(minLength: Tokens.Space.small)
            if selected {
                Image(systemName: "checkmark")
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
