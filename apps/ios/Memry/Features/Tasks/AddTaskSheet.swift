import MemryCore
import SwiftUI

// TP042. The full Add Task sheet (desktop's `add-task-modal.tsx`): title,
// description, project, status, priority, due date and time, start date,
// repeat, tags and parent, with "Create another" keeping the sheet open for
// the next task. The core resolves the default status when none is picked.

/// The full Add Task sheet.
struct AddTaskSheet: View {
    let store: TasksStore
    var initialTitle: String = ""
    var parentId: String?
    var projectId: String?

    @Environment(\.dismiss) private var dismiss
    @State private var draft = TaskDraft()
    @State private var didStart = false
    @State private var createAnother = false
    @State private var showsTitleError = false
    @State private var isSaving = false
    @State private var editing: AddTaskField?
    @FocusState private var titleFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let failure = store.failure {
                    Section { ErrorNotice(error: failure, code: nil) }
                }
                titleSection
                AddTaskPropertiesSection(store: store, draft: $draft, editing: $editing)
                Section(TasksCopy.fieldTags) {
                    NoteTagEditor(
                        tags: draft.tags,
                        suggestions: store.tagSuggestions(""),
                        add: { tag in if !draft.tags.contains(tag) { draft.tags.append(tag) } },
                        remove: { tag in draft.tags.removeAll { $0 == tag } }
                    )
                    .accessibilityIdentifier("tasks.addTask.tags")
                }
                Section {
                    Toggle(TasksCopy.createAnother, isOn: $createAnother)
                        .font(Tokens.Typography.body.font)
                        .accessibilityIdentifier("tasks.addTask.createAnother")
                }
            }
            .navigationTitle(TasksCopy.addTaskTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .sheet(item: $editing) { field in editor(for: field) }
        }
        .accessibilityIdentifier("tasks.addTask.sheet")
        .onAppear(perform: start)
    }

    // MARK: Sections

    private var titleSection: some View {
        Section {
            TextField(TasksCopy.titlePlaceholder, text: $draft.title, axis: .vertical)
                .font(Tokens.Typography.heading.font)
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit { Task { await submit() } }
                .onChange(of: draft.title) { _, title in
                    if !title.isEmpty { showsTitleError = false }
                }
                .accessibilityLabel(TasksCopy.fieldTitle)
                .accessibilityIdentifier("tasks.addTask.title")
            if showsTitleError {
                Text(TasksCopy.titleRequired)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Interaction.destructive.color)
                    .accessibilityIdentifier("tasks.addTask.titleError")
            }
            TextField(TasksCopy.descriptionPlaceholder, text: $draft.description, axis: .vertical)
                .font(Tokens.Typography.body.font)
                .lineLimit(3 ... 10)
                .accessibilityLabel(TasksCopy.fieldDescription)
                .accessibilityIdentifier("tasks.addTask.description")
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(TasksCopy.cancel) { dismiss() }
                .accessibilityIdentifier("tasks.addTask.cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
            Button(TasksCopy.addTaskTitle) { Task { await submit() } }
                .disabled(isSaving || draft.projectId == nil)
                .accessibilityIdentifier("tasks.addTask.submit")
        }
    }

    @ViewBuilder private func editor(for field: AddTaskField) -> some View {
        switch field {
        case .due:
            TaskDateSheet(
                title: TasksCopy.fieldDueDate, date: draft.dueDate, time: draft.dueTime,
                allowsTime: true, store: store
            ) { date, time in
                draft.dueDate = date
                draft.dueTime = date == nil ? nil : time
                editing = nil
            }
        case .start:
            TaskDateSheet(
                title: TasksCopy.fieldStartDate, date: draft.startDate, time: nil,
                allowsTime: false, store: store
            ) { date, _ in
                draft.startDate = date
                editing = nil
            }
        case .repeat:
            RepeatSheet(
                taskId: nil, rule: draft.rule, repeatFrom: draft.repeatFrom,
                anchorDate: draft.dueDate ?? store.today(), store: store
            ) { rule, repeatFrom in
                draft.rule = rule
                draft.repeatFrom = repeatFrom
                editing = nil
            }
        case .parent:
            AddTaskParentPicker(store: store, projectId: draft.projectId, selection: draft.parentId) { parent in
                choose(parent: parent)
                editing = nil
            }
        }
    }

    // MARK: Actions

    private func start() {
        guard !didStart else { return }
        didStart = true
        draft = store.newTaskDraft(title: initialTitle, parentId: parentId, projectId: projectId)
        titleFocused = true
    }

    /// A subtask lives in its parent's project (TP020), so picking a parent
    /// elsewhere moves the draft there.
    private func choose(parent: TaskItem?) {
        draft.parentId = parent?.id
        if let parent, parent.projectId != draft.projectId {
            draft.projectId = parent.projectId
            draft.statusId = nil
        }
    }

    private func submit() async {
        guard !draft.trimmedTitle.isEmpty else {
            showsTitleError = true
            titleFocused = true
            return
        }
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        guard await store.createTask(draft) != nil else { return }
        if createAnother {
            draft.resetForAnother()
            showsTitleError = false
            titleFocused = true
        } else {
            dismiss()
        }
    }
}

/// The pickers the sheet opens on top of itself.
enum AddTaskField: String, Identifiable {
    case due, start, `repeat`, parent

    var id: String { rawValue }
}
