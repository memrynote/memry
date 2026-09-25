import MemryCore
import SwiftUI

// IB14 / IB15. Convert (Paper 14, 15, desktop `convert-actions.tsx`): a type
// segment Note / Task / Reminder and each type's fields. Event is hidden on
// iOS (D6, §6 IB001/F9); the segment offers only what can be written. Note
// hands over to the File sheet's result as desktop's "Note goes back to the
// File sheet" (a note at the root, `convertToNote`).

struct InboxConvertSheet: View {
    enum Target: String, CaseIterable, Identifiable {
        case note, task, reminder
        var id: String { rawValue }
        var label: String {
            switch self {
            case .note: InboxCopy.convertNote
            case .task: InboxCopy.convertTask
            case .reminder: InboxCopy.convertReminder
            }
        }
    }

    let store: InboxStore
    let item: InboxItemRecord
    var done: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var target: Target
    @State private var dueDate: String? = TaskDates.key(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
    @State private var dueTime: String?
    @State private var priority: Int64 = 2
    @State private var remindTaskAt: Date?
    @State private var projectId: String?
    @State private var projects: [ProjectItem] = []
    @State private var remindAt = InboxSnoozePreset.tomorrow.date(now: Date())
    @State private var picking: Picking?
    /// The Tasks pickers read the date rules from a Tasks store; this one
    /// never loads or writes the Tasks tab's view state (its own key).
    @State private var pickerStore: TasksStore?

    private enum Picking: String, Identifiable { case due, reminder; var id: String { rawValue } }

    init(store: InboxStore, item: InboxItemRecord, start: Target = .task, done: @escaping () -> Void = {}) {
        self.store = store
        self.item = item
        self.done = done
        _target = State(initialValue: start)
    }

    var body: some View {
        NavigationStack {
            List {
                Picker(InboxCopy.convertTo, selection: $target) {
                    ForEach(Target.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .accessibilityIdentifier("inbox.convert.type")
                HStack(spacing: Tokens.Space.medium) {
                    Image(systemName: target == .task ? "circle.dashed" : target == .reminder ? "bell" : "doc.text")
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .accessibilityHidden(true)
                    Text(InboxMeta.displayTitle(item))
                        .font(Tokens.Typography.heading.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .lineLimit(2)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: Tokens.Space.small, leading: Tokens.Space.tight, bottom: Tokens.Space.small, trailing: 0))
                switch target {
                case .task: taskFields
                case .reminder: reminderFields
                case .note: Section { EmptyView() } footer: { Text(InboxCopy.noteFooter) }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Tokens.Canvas.background.color)
            .tint(Tokens.Text.tint.color)
            .navigationTitle(InboxCopy.convertTo)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(InboxCopy.close, systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: confirmLabel, isEnabled: target != .reminder || remindAt > Date()) {
                        confirm()
                    }
                    .accessibilityIdentifier("inbox.convert.confirm")
                }
            }
            .sheet(item: $picking) { picking in
                switch picking {
                case .due:
                    if let pickerStore {
                        TaskDateSheet(title: InboxCopy.dueDate, date: dueDate, time: dueTime, allowsTime: true, store: pickerStore) {
                            dueDate = $0
                            dueTime = $1
                        }
                    }
                case .reminder:
                    TaskReminderPickerSheet(mode: .add, now: store.clock()) { date, _ in remindTaskAt = date }
                }
            }
            .task { await loadProjects() }
        }
        .presentationDetents([.large])
        .accessibilityIdentifier("inbox.convertSheet")
    }

    private var confirmLabel: String {
        switch target {
        case .note: InboxCopy.createNoteAction
        case .task: InboxCopy.addTask
        case .reminder: InboxCopy.setReminder
        }
    }

    /// Paper 14: Due date, Priority, Remind me, Project, each a row with its
    /// value and a chevron; the date and reminder open the Tasks pickers.
    private var taskFields: some View {
        Section {
            let today = TaskDates.key(store.clock())
            let due = dueDate.flatMap { TaskDueLabel.make(date: $0, time: dueTime, today: today, isDone: false) }
            valueRow(InboxCopy.dueDate, value: due?.text ?? InboxCopy.none,
                     color: due.map { TaskComposerChips.dueColor($0.tone) } ?? Tokens.Text.tertiary) { picking = .due }
                .accessibilityIdentifier("inbox.convert.due")
            Menu {
                Picker(InboxCopy.priority, selection: $priority) {
                    ForEach([Int64(4), 3, 2, 1, 0], id: \.self) { Text(InboxCopy.priorityName($0)).tag($0) }
                }
            } label: {
                valueLabel(InboxCopy.priority, value: InboxCopy.priorityName(priority), color: Tokens.Text.tertiary)
            }
            .accessibilityIdentifier("inbox.convert.priority")
            valueRow(InboxCopy.remindMe, value: reminderLabel, color: Tokens.Text.tertiary) { picking = .reminder }
                .accessibilityIdentifier("inbox.convert.remind")
            Menu {
                Picker(InboxCopy.project, selection: $projectId) {
                    Text(InboxCopy.inboxProject).tag(String?.none)
                    ForEach(projects.filter { !$0.isInbox && $0.archivedAt == nil }, id: \.id) {
                        Text($0.name).tag(Optional($0.id))
                    }
                }
            } label: {
                let project = projects.first { $0.id == projectId }
                valueLabel(InboxCopy.project, value: project?.name ?? InboxCopy.inboxProject, color: Tokens.Text.tertiary) {
                    Circle().fill(project.map { Tokens.Palette.color($0.color) } ?? Tokens.Text.tertiary.color)
                        .frame(width: Tokens.Space.tight + 2, height: Tokens.Space.tight + 2)
                }
            }
            .accessibilityIdentifier("inbox.convert.project")
        } footer: {
            Text(InboxCopy.convertFooter)
        }
        .listRowBackground(Tokens.Canvas.surface.color)
    }

    private func valueRow(_ label: String, value: String, color: AdaptiveColor, action: @escaping () -> Void) -> some View {
        Button(action: action) { valueLabel(label, value: value, color: color) }
            .buttonStyle(.plain)
    }

    private func valueLabel(
        _ label: String, value: String, color: AdaptiveColor, @ViewBuilder dot: () -> some View = { EmptyView() }
    ) -> some View {
        HStack(spacing: Tokens.Space.small) {
            Text(label).foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.small)
            dot()
            Text(value).foregroundStyle(color.color)
            Image(systemName: "chevron.right")
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
        }
        .font(Tokens.Typography.body.font)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var reminderFields: some View {
        Section {
            DatePicker(InboxCopy.remindAt, selection: $remindAt, in: Date()..., displayedComponents: .date)
            DatePicker(InboxCopy.time, selection: $remindAt, displayedComponents: .hourAndMinute)
        } footer: {
            Text(InboxCopy.reminderFooter)
        }
        .listRowBackground(Tokens.Canvas.surface.color)
    }

    private func loadProjects() async {
        guard let tasks = store.tasks else { return }
        if pickerStore == nil {
            pickerStore = TasksStore(core: tasks, filler: nil, vaultId: "inbox-convert-picker")
        }
        projects = (try? await store.executorRun { try tasks.projects(includeArchived: false) }) ?? []
    }

    private var reminderLabel: String {
        guard let remindTaskAt else { return InboxCopy.none }
        return InboxPanelFormat.when(Int64(remindTaskAt.timeIntervalSince1970 * 1000), now: store.clock())
    }

    private func confirm() {
        let item = item
        let target = target
        let dueDate = dueDate
        let dueTime = dueDate == nil ? nil : dueTime
        let priority = priority
        let projectId = projectId
        let remindTaskAt = remindTaskAt
        let remindAt = remindAt
        dismiss()
        Task {
            switch target {
            case .note:
                await store.convertToNote(item)
            case .task:
                let taskId = await store.convertToTask(
                    item, projectId: projectId, dueDate: dueDate, dueTime: dueTime, priority: priority
                )
                if let taskId, let remindTaskAt, let tasks = store.tasks {
                    let iso = TaskDates.iso(remindTaskAt)
                    _ = try? await store.executorRun { try tasks.addTaskReminder(taskId: taskId, remindAt: iso, title: nil, note: nil) }
                    store.scheduleSync()
                }
            case .reminder:
                await store.convertToReminder(item, at: remindAt)
            }
            done()
        }
    }
}
