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
    @State private var target: Target = .task
    @State private var hasDue = true
    @State private var due = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    @State private var hasTime = false
    @State private var priority: Int64 = 2
    @State private var remind: InboxRemindPreset = .none
    @State private var projectId: String?
    @State private var projects: [ProjectItem] = []
    @State private var remindAt = InboxSnoozePreset.tomorrow.date(now: Date())

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(InboxCopy.convertTo, selection: $target) {
                        ForEach(Target.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("inbox.convert.type")
                    Text(InboxMeta.displayTitle(item))
                        .font(Tokens.Typography.body.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.primary.color)
                }
                switch target {
                case .task: taskFields
                case .reminder: reminderFields
                case .note: Section { Text(InboxCopy.noteFooter).font(Tokens.Typography.supporting.font) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Tokens.Canvas.background.color)
            .navigationTitle(InboxCopy.convert)
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
            .task { await loadProjects() }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("inbox.convertSheet")
    }

    private var confirmLabel: String {
        switch target {
        case .note: InboxCopy.createNoteAction
        case .task: InboxCopy.addTask
        case .reminder: InboxCopy.setReminder
        }
    }

    private var taskFields: some View {
        Group {
            Section {
                Toggle(InboxCopy.dueDate, isOn: $hasDue)
                if hasDue {
                    DatePicker(InboxCopy.dueDate, selection: $due, displayedComponents: hasTime ? [.date, .hourAndMinute] : .date)
                    Toggle(InboxCopy.dueTime, isOn: $hasTime)
                }
                Picker(InboxCopy.priority, selection: $priority) {
                    ForEach([Int64(0), 1, 2, 3, 4], id: \.self) { Text(InboxCopy.priorityName($0)).tag($0) }
                }
                Picker(InboxCopy.remindMe, selection: $remind) {
                    ForEach(InboxRemindPreset.allCases) { Text($0.label).tag($0) }
                }
                Picker(InboxCopy.project, selection: $projectId) {
                    Text(InboxCopy.inboxProject).tag(String?.none)
                    ForEach(projects.filter { !$0.isInbox && $0.archivedAt == nil }, id: \.id) {
                        Text($0.name).tag(Optional($0.id))
                    }
                }
                .accessibilityIdentifier("inbox.convert.project")
            } footer: {
                Text(InboxCopy.convertFooter)
            }
        }
    }

    private var reminderFields: some View {
        Section {
            DatePicker(InboxCopy.remindAt, selection: $remindAt, in: Date()..., displayedComponents: .date)
            DatePicker(InboxCopy.time, selection: $remindAt, displayedComponents: .hourAndMinute)
        } footer: {
            Text(InboxCopy.reminderFooter)
        }
    }

    private func loadProjects() async {
        guard let tasks = store.tasks else { return }
        projects = (try? await store.executorRun { try tasks.projects(includeArchived: false) }) ?? []
    }

    private func confirm() {
        let item = item
        let target = target
        let dueDate = hasDue ? TaskDates.key(due) : nil
        let dueTime = hasDue && hasTime ? due.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) : nil
        let priority = priority
        let projectId = projectId
        let remind = remind
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
                if let taskId, let when = remind.date(now: store.clock()), let tasks = store.tasks {
                    let iso = TaskDates.iso(when)
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

/// The task reminder presets Convert offers (desktop's reminder picker:
/// 1 hour, Tomorrow, Next week).
enum InboxRemindPreset: String, CaseIterable, Identifiable {
    case none, inOneHour, tomorrow, nextWeek
    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: InboxCopy.none
        case .inOneHour: "1 hour"
        case .tomorrow: "Tomorrow"
        case .nextWeek: "Next week"
        }
    }

    func date(now: Date) -> Date? {
        switch self {
        case .none: nil
        case .inOneHour: InboxSnoozePreset.inOneHour.date(now: now)
        case .tomorrow: InboxSnoozePreset.tomorrow.date(now: now)
        case .nextWeek: InboxSnoozePreset.nextWeek.date(now: now)
        }
    }
}
