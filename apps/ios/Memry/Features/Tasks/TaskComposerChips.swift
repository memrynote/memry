import MemryCore
import SwiftUI

// RD03 / RD04. The composer's chip row (Paper "Chip scroller (horizontal)"):
// Date (the When menu), Priority, Project, "#" (tags) and "…" (Status, Parent
// task, Reminder, Start date, More fields…, syntax help). A chip is neutral
// until its property is set, then carries the value in its own domain colour.
// Each is one tap to open and one to choose (rule 1 of artboard 00).

struct TaskComposerChips: View {
    let store: TasksStore
    let values: TaskComposerValues
    @Binding var draft: TaskComposerDraft
    let insertTag: () -> Void
    let showsHelp: () -> Void
    let pickSheet: (TaskComposerSheet.Which) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Tokens.Space.tight) {
                dateChip
                priorityChip
                projectChip
                tagChip
                moreChip
            }
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Date

    private var dateChip: some View {
        Menu {
            TaskWhenMenu(store: store, actions: whenActions)
        } label: {
            let label = values.dueDate.flatMap {
                TaskDueLabel.make(date: $0, time: values.dueTime, today: store.today(), isDone: false)
            }
            let tone: TaskPillTone = label.map { TaskPillTone.tinted(Self.dueColor($0.tone)) } ?? .neutral
            TaskComposerChip(text: label?.text ?? TasksCopy.composerDate, tone: tone) {
                Image(systemName: "calendar").accessibilityHidden(true)
                if values.rule != nil { Image(systemName: "repeat").accessibilityHidden(true) }
                if values.reminder != nil { Image(systemName: "bell").accessibilityHidden(true) }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.composerDateLabel(values.dueDate == nil ? nil : chipDateText))
        .accessibilityIdentifier("tasks.composer.date")
    }

    private var chipDateText: String? {
        values.dueDate.flatMap {
            TaskDueLabel.make(date: $0, time: values.dueTime, today: store.today(), isDone: false)?.text
        }
    }

    private var whenActions: TaskWhenActions {
        TaskWhenActions(
            date: values.dueDate,
            rule: values.rule,
            reminderCount: values.reminder == nil ? 0 : 1,
            setDate: { date in draft.due = .set(date: date, time: values.dueTime) },
            removeDate: { draft.due = .cleared },
            pickDateTime: { pickSheet(.when) },
            setRule: { rule in draft.rule = rule.map { .set($0, repeatFrom: nil) } ?? .cleared },
            addReminder: { date in draft.reminder = date }
        )
    }

    static func dueColor(_ tone: TaskDueLabel.Tone) -> AdaptiveColor {
        switch tone {
        case .overdue: Tokens.Task.dueOverdue
        case .today: Tokens.Task.dueToday
        case .tomorrow: Tokens.Task.dueTomorrow
        case .upcoming: Tokens.Task.dueUpcoming
        case .later, .done: Tokens.Text.secondary
        }
    }

    // MARK: Priority

    private var priorityChip: some View {
        Menu {
            Picker(TasksCopy.fieldPriority, selection: Binding(
                get: { values.priority },
                set: { draft.priority = $0 }
            )) {
                ForEach([Int64(4), 3, 2, 1, 0], id: \.self) { (value: Int64) in
                    Text(TasksCopy.priorityLabel(value)).tag(value)
                }
            }
            .pickerStyle(.inline)
        } label: {
            if values.priority > 0 {
                TaskComposerChip(
                    text: TasksCopy.priorityLabel(values.priority),
                    tone: .tinted(Tokens.Task.priority(values.priority))
                ) {
                    TaskPriorityIcon(priority: values.priority, font: Tokens.Typography.supporting.font)
                }
            } else {
                TaskComposerChip(text: nil) {
                    Image(systemName: "cellularbars", variableValue: 0).accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.composerPriorityLabel(values.priority))
        .accessibilityIdentifier("tasks.composer.priority")
    }

    // MARK: Project

    private var projectChip: some View {
        Menu {
            Picker(TasksCopy.fieldProject, selection: Binding(
                get: { values.projectId },
                set: { id in
                    draft.projectId = id
                    draft.statusId = nil
                }
            )) {
                ForEach(store.projects.filter { $0.archivedAt == nil }, id: \.id) { project in
                    Text(project.name).tag(Optional(project.id))
                }
            }
            .pickerStyle(.inline)
        } label: {
            let project = store.project(values.projectId)
            TaskComposerChip(text: project?.name ?? TasksCopy.composerNoProject) {
                TaskProjectDot(color: project?.color, font: Tokens.Typography.supporting.font)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.composerProjectLabel(store.project(values.projectId)?.name))
        .accessibilityIdentifier("tasks.composer.project")
    }

    // MARK: Tags

    private var tagChip: some View {
        Menu {
            let suggestions = Array(store.tagSuggestions("").prefix(12))
            if !suggestions.isEmpty {
                Section {
                    ForEach(suggestions, id: \.self) { tag in
                        Toggle("#\(tag)", isOn: Binding(
                            get: { values.tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame } },
                            set: { on in
                                if on {
                                    draft.tags.append(tag)
                                } else {
                                    draft.tags.removeAll { $0.caseInsensitiveCompare(tag) == .orderedSame }
                                }
                            }
                        ))
                    }
                }
            }
            Button(TasksCopy.composerNewTag, systemImage: "number", action: insertTag)
        } label: {
            if values.tags.isEmpty {
                TaskComposerChip(text: nil) { Text("#").accessibilityHidden(true) }
            } else {
                TaskComposerChip(text: TasksCopy.composerTags(values.tags), tone: .tinted(Tokens.Task.tokenTag)) {
                    EmptyView()
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.composerTagsLabel(values.tags))
        .accessibilityIdentifier("tasks.composer.tags")
    }

    // MARK: More

    private var moreChip: some View {
        Menu {
            let statuses = (store.project(values.projectId)?.statuses ?? []).sorted { $0.position < $1.position }
            if !statuses.isEmpty {
                Menu {
                    Picker(TasksCopy.fieldStatus, selection: Binding(
                        get: { values.statusId ?? statuses.first(where: \.isDefault)?.id ?? statuses.first?.id },
                        set: { draft.statusId = $0 }
                    )) {
                        ForEach(statuses, id: \.id) { status in
                            Label(
                                status.name,
                                systemImage: TaskStatusGlyph.symbol(statusType: status.statusType, isDone: status.isDone)
                            )
                            .tag(Optional(status.id))
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Label(TasksCopy.fieldStatus, systemImage: "circle.dashed")
                }
            }
            Button(TasksCopy.fieldParent, systemImage: "arrow.turn.down.right") { pickSheet(.parent) }
            Menu {
                ForEach(TaskReminderPresets.standard(now: store.clock())) { preset in
                    Button {
                        draft.reminder = preset.date
                    } label: {
                        Text(preset.label)
                        if let detail = preset.detail { Text(detail) }
                    }
                }
                Button(TasksCopy.reminderCustom) { pickSheet(.when) }
                if draft.reminder != nil {
                    Button(TasksCopy.composerNoReminder, role: .destructive) { draft.reminder = nil }
                }
            } label: {
                Label(TasksCopy.composerReminder, systemImage: "bell")
            }
            Button(TasksCopy.fieldStartDate, systemImage: "calendar.badge.clock") { pickSheet(.start) }
            Button(TasksCopy.composerMoreFields, systemImage: "slider.horizontal.3") { pickSheet(.when) }
            Section {
                Button(TasksCopy.quickAddHelp, systemImage: "questionmark.circle", action: showsHelp)
            }
        } label: {
            TaskComposerChip(text: nil) {
                Image(systemName: "ellipsis").accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.composerMore)
        .accessibilityIdentifier("tasks.composer.more")
    }
}

/// The sheets the composer opens on top of itself.
struct TaskComposerSheet: View {
    enum Which: String, Identifiable {
        case when, start, parent

        var id: String { rawValue }
    }

    let store: TasksStore
    let which: Which
    let values: TaskComposerValues
    @Binding var draft: TaskComposerDraft

    var body: some View {
        switch which {
        case .when:
            TaskWhenSheet(
                store: store,
                target: .draft(TaskWhenDraft(values: values)),
                onCommit: { result, original in draft.apply(result, from: original) }
            )
        case .start:
            TaskDateSheet(
                title: TasksCopy.fieldStartDate, date: values.startDate, time: nil, allowsTime: false, store: store
            ) { date, _ in
                draft.startDate = date
            }
        case .parent:
            AddTaskParentPicker(store: store, projectId: values.projectId, selection: values.parentId) { parent in
                draft.parentId = parent?.id
                if let parent, parent.projectId != values.projectId {
                    draft.projectId = parent.projectId
                    draft.statusId = nil
                }
            }
        }
    }
}
