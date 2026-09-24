import MemryCore
import SwiftUI

// TP043, redesigned (RD08, RD10). A task's detail (Paper artboard 08): the
// status circle (tap completes or reopens) beside a large editable title;
// pills for the properties that are set, and a dashed "+" for the rest
// (`TaskDetailPills`); the notes; the subtasks with their progress and an
// inline Add subtask; Linked, only when something is; and one footer line
// (created, edited) that opens the activity. The "…" in the bar holds
// Duplicate, Make subtask of…, Activity, Archive and Delete (artboard 10).
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
                TaskDetailContent(task: task, store: store)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            TaskDetailMoreMenu(task: task, store: store, onDelete: requestDelete)
                        }
                    }
            } else if !checked || store.isLoading {
                ProgressView(TasksCopy.loading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TaskDetailMissing()
            }
        }
        .background(Tokens.Canvas.background.color)
        .navigationTitle("")
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

    @State private var linked: [LinkedItemRecord] = []

    var body: some View {
        List {
            Group {
                if let failure = store.failure {
                    ErrorNotice(error: failure, code: nil)
                        .listRowSeparator(.hidden)
                }
                TaskDetailHeader(task: task, store: store)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(
                        top: Tokens.Space.medium, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge
                    ))
                TaskDetailPills(task: task, store: store)
                    .listRowSeparator(.hidden)
                    .listRowInsets(TaskDetailLayout.bodyInsets(top: Tokens.Space.small))
                TaskDescriptionSection(task: task, store: store)
                SubtasksSection(parent: task, store: store)
                TaskRelatedSection(task: task, store: store, linked: linked)
                TaskDetailFooter(task: task, store: store)
            }
            // Plain-list cells default to the system background (black in dark),
            // not the canvas.
            .listRowBackground(Tokens.Canvas.background.color)
        }
        .linkedItemsLoader(task: task, store: store, into: $linked)
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("tasks.detail")
    }
}

/// The detail's column: everything under the title starts where the title
/// text does (Paper: the 20pt edge, the 28pt status lane and its 12pt gap).
enum TaskDetailLayout {
    static let lane = TaskLayout.lane + Tokens.Space.tight
    static let bodyLeading = TaskLayout.edge + lane + Tokens.Space.medium

    static func bodyInsets(top: CGFloat = 0, bottom: CGFloat = 0) -> EdgeInsets {
        EdgeInsets(top: top, leading: bodyLeading, bottom: bottom, trailing: TaskLayout.edge)
    }
}

/// The status circle and the large editable title (Paper "Title (editable)").
struct TaskDetailHeader: View {
    let task: TaskItem
    let store: TasksStore

    @State private var completions = 0
    /// Grows with the title's Dynamic Type so the circle stays on screen at
    /// accessibility sizes.
    @ScaledMetric(relativeTo: .title) private var lane = TaskDetailLayout.lane

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            Text(verbatim: "A")
                .font(TaskDetailTitleField.font)
                .hidden()
                .frame(width: lane)
                .overlay {
                    Button(action: toggle) {
                        TaskStatusIcon(
                            statusType: task.statusType,
                            isDone: task.isDone,
                            color: store.rowStatus(task).map { Tokens.Palette.color($0.color) },
                            scale: .large
                        )
                        .font(TaskDetailTitleField.font)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.borderless)
                    .sensoryFeedback(.success, trigger: completions)
                    .accessibilityLabel(task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete)
                    .accessibilityIdentifier("tasks.detail.complete")
                }
            TaskDetailTitleField(task: task, store: store)
        }
    }

    private func toggle() {
        if !task.isDone { completions += 1 }
        let task = task
        Task { await store.requestComplete(task) }
    }
}

/// The editable title. Commits on return and when focus leaves; a blank title
/// is dropped and the stored one comes back (a task cannot be untitled).
struct TaskDetailTitleField: View {
    let task: TaskItem
    let store: TasksStore

    /// Paper's 28pt bold title: the title-one step.
    static var font: Font { TypeRole(.documentTitle, weight: .bold).font }

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField(TasksCopy.Detail.namePlaceholder, text: $draft, axis: .vertical)
            .font(Self.font)
            .foregroundStyle(task.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
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

/// The detail's "…" (artboard 10): Duplicate, Make subtask of…, Activity,
/// Archive (Unarchive), Delete behind desktop's confirmation.
struct TaskDetailMoreMenu: View {
    let task: TaskItem
    let store: TasksStore
    let onDelete: (TaskItem) -> Void

    @State private var isPickingParent = false
    @State private var isConfirmingDuplicate = false
    @State private var isConfirmingDelete = false
    @State private var showsActivity = false

    var body: some View {
        Menu {
            Section {
                Button(TasksCopy.rowDuplicate, systemImage: "plus.square.on.square", action: duplicate)
                    .accessibilityIdentifier("tasks.detail.duplicate")
                if store.rowCanBecomeSubtask(task) {
                    Button(TasksCopy.rowMakeSubtaskOf, systemImage: "arrow.turn.down.right") { isPickingParent = true }
                        .accessibilityIdentifier("tasks.detail.makeSubtask")
                }
                Button(TasksCopy.Detail.activity, systemImage: "clock.arrow.circlepath") { showsActivity = true }
                    .accessibilityIdentifier("tasks.detail.activityMenu")
            }
            Section {
                Button(
                    task.archivedAt == nil ? TasksCopy.rowArchive : TasksCopy.rowUnarchive,
                    systemImage: task.archivedAt == nil ? "archivebox" : "tray.and.arrow.up"
                ) {
                    let task = task
                    Task {
                        if task.archivedAt == nil { await store.rowToggleArchive(task) } else { await store.detailUnarchive(task) }
                    }
                }
                .accessibilityIdentifier(task.archivedAt == nil ? "tasks.detail.archive" : "tasks.detail.unarchive")
                Button(TasksCopy.rowDelete, systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                    .accessibilityIdentifier("tasks.detail.delete")
            }
        } label: {
            Image(systemName: "ellipsis")
                .accessibilityLabel(TasksCopy.more)
        }
        .accessibilityIdentifier("tasks.detail.more")
        .sheet(isPresented: $isPickingParent) { ParentPickerSheet(task: task, store: store) }
        .sheet(isPresented: $showsActivity) {
            TaskActivitySheet(taskId: task.id, taskTitle: task.title, store: store)
        }
        .confirmationDialog(TasksCopy.rowDuplicateTitle, isPresented: $isConfirmingDuplicate, titleVisibility: .visible) {
            Button(TasksCopy.rowDuplicateWithItems(store.subtasks(of: task.id).count + 1)) { runDuplicate(true) }
            Button(TasksCopy.rowDuplicateTaskOnly) { runDuplicate(false) }
            Button(TasksCopy.rowCancel, role: .cancel) {}
        } message: {
            Text(TasksCopy.rowDuplicateMessage(task.title))
        }
        .alert(TasksCopy.Detail.deleteTaskQuestion, isPresented: $isConfirmingDelete) {
            Button(TasksCopy.Detail.cancel, role: .cancel) {}
            Button(TasksCopy.Detail.deleteTaskConfirm, role: .destructive) { onDelete(task) }
                .accessibilityIdentifier("tasks.detail.deleteConfirm")
        } message: {
            Text(TasksCopy.Detail.deleteConfirmBody(task.title))
        }
    }

    private func duplicate() {
        if store.subtasks(of: task.id).isEmpty { runDuplicate(false) } else { isConfirmingDuplicate = true }
    }

    private func runDuplicate(_ withSubtasks: Bool) {
        let task = task
        Task { await store.rowDuplicate(task, withSubtasks: withSubtasks) }
    }
}
