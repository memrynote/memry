import MemryCore
import SwiftUI

// TP042. The Add Task sheet's property rows (desktop's `PropertyRow` grid:
// status, priority, due date, project, plus start date, repeat and parent)
// and the parent picker.

/// Project, status, priority, dates, repeat and parent.
struct AddTaskPropertiesSection: View {
    let store: TasksStore
    @Binding var draft: TaskDraft
    @Binding var editing: AddTaskField?

    var body: some View {
        Section {
            Picker(TasksCopy.fieldProject, selection: projectBinding) {
                ForEach(liveProjects, id: \.id) { project in
                    Text(project.name).tag(Optional(project.id))
                }
            }
            .accessibilityIdentifier("tasks.addTask.project")

            if !statuses.isEmpty {
                Picker(TasksCopy.fieldStatus, selection: statusBinding) {
                    ForEach(statuses, id: \.id) { status in
                        Text(status.name).tag(Optional(status.id))
                    }
                }
                .accessibilityIdentifier("tasks.addTask.status")
            }

            Picker(TasksCopy.fieldPriority, selection: $draft.priority) {
                ForEach([Int64(0), 1, 2, 3, 4], id: \.self) { value in
                    Text(TasksCopy.priorityLabel(value)).tag(value)
                }
            }
            .accessibilityIdentifier("tasks.addTask.priority")
        }

        Section {
            row(TasksCopy.fieldDueDate, value: dueText, field: .due, identifier: "tasks.addTask.dueDate")
            row(TasksCopy.fieldStartDate, value: startText, field: .start, identifier: "tasks.addTask.startDate")
            row(
                TasksCopy.fieldRepeat,
                value: draft.rule == nil ? TasksCopy.doesNotRepeat : TasksCopy.repeats,
                field: .repeat,
                identifier: "tasks.addTask.repeat"
            )
            row(TasksCopy.fieldParent, value: parentText, field: .parent, identifier: "tasks.addTask.parent")
        }
    }

    private func row(_ label: String, value: String, field: AddTaskField, identifier: String) -> some View {
        Button { editing = field } label: {
            LabeledContent(label) {
                Text(value)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .lineLimit(1)
            }
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }

    // MARK: Values

    private var liveProjects: [ProjectItem] {
        store.projects.filter { $0.archivedAt == nil || $0.id == draft.projectId }
    }

    private var statuses: [StatusItem] {
        (store.project(draft.projectId)?.statuses ?? []).sorted { $0.position < $1.position }
    }

    private var projectBinding: Binding<String?> {
        Binding(
            get: { draft.projectId },
            set: { id in
                guard id != draft.projectId else { return }
                draft.projectId = id
                draft.statusId = nil
                if let parent = draft.parentId, store.items[parent]?.projectId != id {
                    draft.parentId = nil
                }
            }
        )
    }

    /// `nil` (the core's default) reads as the project's default status.
    private var statusBinding: Binding<String?> {
        Binding(
            get: { draft.statusId ?? statuses.first(where: \.isDefault)?.id ?? statuses.first?.id },
            set: { draft.statusId = $0 }
        )
    }

    private var dueText: String {
        guard let date = draft.dueDate else { return TasksCopy.addNoDate }
        return TaskDueLabel.make(date: date, time: draft.dueTime, today: store.today(), isDone: false)?.text ?? date
    }

    private var startText: String {
        guard let date = draft.startDate else { return TasksCopy.addNoDate }
        return TaskDueLabel.make(date: date, time: nil, today: store.today(), isDone: false)?.text ?? date
    }

    private var parentText: String {
        guard let id = draft.parentId else { return TasksCopy.noParent }
        return store.items[id]?.title ?? TasksCopy.noParent
    }
}

/// Picks the task a new task is filed under: this project's first, then the
/// other projects', searchable.
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
                    Button(TasksCopy.cancel) { dismiss() }
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
