import MemryCore
import SwiftUI

// TP043. A task's detail screen, after desktop's `task-detail-drawer.tsx`:
// title, the properties (status, priority, start, due, reminders, project,
// repeat), tags, description, subtasks, related items, activity, and the
// footer (unarchive, delete, created/archived).
//
// **A task id that is not in this vault** (deleted elsewhere, or not pulled
// yet) renders a calm "no longer in this vault" state (FR-061), never a
// crash and never a ghost: the store's copy is the only source, and the core
// is asked once when the store has not got it yet.

/// TP043 — a task's detail screen.
struct TaskDetailView: View {
    let taskId: String
    let store: TasksStore

    /// Whether the core has been asked about an id the store did not hold.
    @State private var checked = false
    /// Set once the user confirmed a delete from here, so the screen closes
    /// when the task goes rather than showing the missing state.
    @State private var deleteRequested = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let task = store.items[taskId] {
                TaskDetailContent(task: task, store: store, onDelete: requestDelete)
            } else if !checked || store.isLoading {
                ProgressView(TasksCopy.loading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TaskDetailMissing()
            }
        }
        .background(Tokens.Canvas.background.color)
        .navigationTitle(TasksCopy.Detail.details)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: taskId) { await check() }
        .onChange(of: store.items[taskId] == nil) { _, gone in
            if gone, deleteRequested { dismiss() }
        }
    }

    /// Asks the core for an id the store does not hold; a hit means the store
    /// is behind, so it refreshes.
    private func check() async {
        defer { checked = true }
        guard store.items[taskId] == nil else { return }
        let id = taskId
        let found = await store.read { try $0.get(id: id) }
        if case .some(.some) = found { await store.refresh() }
    }

    private func requestDelete(_ task: TaskItem) {
        deleteRequested = true
        Task { await store.requestDelete(task) }
    }
}

/// FR-061: the task this screen was opened for is gone.
struct TaskDetailMissing: View {
    var body: some View {
        ContentUnavailableView {
            Label(TasksCopy.Detail.taskMissingTitle, systemImage: "checkmark.circle.badge.questionmark")
        } description: {
            Text(TasksCopy.Detail.taskMissingDetail)
        }
        .accessibilityIdentifier("tasks.detail.missing")
    }
}

/// The detail of one task that exists.
struct TaskDetailContent: View {
    let task: TaskItem
    let store: TasksStore
    let onDelete: (TaskItem) -> Void

    var body: some View {
        List {
            if let failure = store.failure {
                Section {
                    ErrorNotice(error: failure, code: nil)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            Section {
                TaskDetailTitleField(task: task, store: store)
            }
            TaskDetailProperties(task: task, store: store)
            TaskRemindersSection(task: task, store: store)
            TaskDetailTags(task: task, store: store)
            TaskDescriptionSection(task: task, store: store)
            SubtasksSection(parent: task, store: store)
            TaskRelatedSection(task: task, store: store)
            TaskActivitySection(task: task, store: store)
            TaskDetailFooter(task: task, store: store, onDelete: onDelete)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("tasks.detail")
    }
}

/// The editable title. Commits on return and when focus leaves; a blank title
/// is dropped and the stored one comes back (a task cannot be untitled).
struct TaskDetailTitleField: View {
    let task: TaskItem
    let store: TasksStore

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField(TasksCopy.Detail.namePlaceholder, text: $draft, axis: .vertical)
            .font(Tokens.Typography.sectionTitle.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .strikethrough(task.isDone, color: Tokens.Text.tertiary.color)
            .focused($focused)
            .submitLabel(.done)
            .onSubmit { focused = false }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityLabel(TasksCopy.Detail.namePlaceholder)
            .accessibilityIdentifier("tasks.detail.title")
            .onAppear { draft = task.title }
            .onChange(of: task.title) { _, title in
                if !focused { draft = title }
            }
            .onChange(of: focused) { _, isFocused in
                if !isFocused { commit() }
            }
            .onChange(of: draft) { _, text in
                // Return in a vertical field inserts a newline; treat it as
                // submit instead, since a title is one line.
                if text.contains("\n") {
                    draft = text.replacingOccurrences(of: "\n", with: "")
                    focused = false
                }
            }
    }

    private func commit() {
        let text = draft
        let current = store.items[task.id] ?? task
        Task {
            let wrote = await store.detailRename(current, to: text)
            if !wrote { draft = store.items[task.id]?.title ?? task.title }
        }
    }
}
