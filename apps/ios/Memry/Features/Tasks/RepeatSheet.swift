import MemryCore
import SwiftUI

// TP045. How a task repeats: "Does not repeat", desktop's seven presets
// anchored on the due date (else today), a custom rule, and whether the next
// occurrence counts from the due date or the completion date. After desktop's
// `repeat-picker.tsx`, `task-repeat-section.tsx` and `repeat-indicator.tsx`.
//
// **Done decides, the dialogs write.** A new task, or a task not yet
// repeating, gets its rule through `onCommit`. For a task that already
// repeats the sheet raises the Stop Repeating or Edit Repeating question
// (`repeatPrompts(store:)`), and the answer writes; `onCommit` is not called.
// The question is raised once the sheet has gone, so the dialog is not asked
// to present over a sheet that is still leaving.

/// TP045 — repeat presets and custom rule.
struct RepeatSheet: View {
    /// The task being edited; `nil` while composing a new task.
    let taskId: String?
    let rule: RepeatRule?
    let repeatFrom: String?
    let anchorDate: String?
    let store: TasksStore
    let onCommit: (RepeatRule?, String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: RepeatRule?
    @State private var draftFrom: String?
    @State private var touched = false
    @State private var customizing = false
    @State private var raised: TasksPrompt?

    init(
        taskId: String?,
        rule: RepeatRule?,
        repeatFrom: String?,
        anchorDate: String?,
        store: TasksStore,
        onCommit: @escaping (RepeatRule?, String?) -> Void
    ) {
        self.taskId = taskId
        self.rule = rule
        self.repeatFrom = repeatFrom
        self.anchorDate = anchorDate
        self.store = store
        self.onCommit = onCommit
        _draft = State(initialValue: rule)
        _draftFrom = State(initialValue: repeatFrom)
    }

    private var wasRepeating: Bool { rule != nil || store.isRepeating(taskId) }
    private var presets: [RepeatPreset] { store.repeatPresets(anchorDate: anchorDate) }

    var body: some View {
        NavigationStack {
            List {
                if wasRepeating { RepeatCurrentSection(rule: rule, repeatFrom: repeatFrom) }
                Section {
                    choiceRow(TasksCopy.doesNotRepeat, selected: touched ? draft == nil : !wasRepeating, id: "none") {
                        choose(nil)
                    }
                    ForEach(presets) { preset in
                        choiceRow(
                            TasksCopy.repeatPresetLabel(preset),
                            selected: draft.map { TasksCopy.repeatSummary($0) == TasksCopy.repeatSummary(preset.rule) }
                                ?? false,
                            id: preset.id
                        ) {
                            choose(matchesCurrent(preset) ? rule : preset.rule)
                        }
                    }
                }
                Section {
                    Button {
                        customizing = true
                    } label: {
                        HStack {
                            Text(TasksCopy.customRepeatRow).foregroundStyle(Tokens.Text.primary.color)
                            Spacer()
                            Image(systemName: "chevron.forward")
                                .foregroundStyle(Tokens.Text.tertiary.color)
                                .accessibilityHidden(true)
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("tasks.repeat.custom")
                }
                if let draft {
                    Section(TasksCopy.repeatFromTitle) { repeatFromPicker }
                    Section { draftSummary(draft) }
                }
            }
            .font(Tokens.Typography.body.font)
            .navigationTitle(TasksCopy.repeatTitle)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $customizing) {
                RepeatCustomEditor(initial: draft ?? rule, anchorDate: anchorDate, store: store) { custom in
                    choose(custom)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(TasksCopy.repeatCancel) { dismiss() }
                        .accessibilityIdentifier("tasks.repeat.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(TasksCopy.repeatDone, action: finish)
                        .accessibilityIdentifier("tasks.repeat.done")
                }
            }
        }
        .onDisappear {
            if let raised { store.prompt = raised }
        }
    }

    // MARK: Rows

    private func choiceRow(_ title: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Tokens.Text.primary.color)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("tasks.repeat.preset.\(id)")
    }

    private var repeatFromPicker: some View {
        Picker(TasksCopy.repeatFromTitle, selection: Binding(
            get: { draftFrom ?? "due" },
            set: { value in
                touched = true
                // Desktop writes no anchor for "due"; keep it absent unless it was set.
                draftFrom = value == "due" && repeatFrom == nil ? nil : value
            }
        )) {
            Text(TasksCopy.repeatFromDue).tag("due")
            Text(TasksCopy.repeatFromCompletion).tag("completion")
        }
        .pickerStyle(.segmented)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityIdentifier("tasks.repeat.from")
    }

    private func draftSummary(_ draft: RepeatRule) -> some View {
        Label(TasksCopy.repeatSummary(draft), systemImage: "repeat")
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Task.repeatMark.color)
            .accessibilityIdentifier("tasks.repeat.summary")
    }

    // MARK: Actions

    /// A preset equal to the current rule keeps it, count and creation included.
    private func matchesCurrent(_ preset: RepeatPreset) -> Bool {
        guard let rule else { return false }
        return TasksCopy.repeatSummary(rule) == TasksCopy.repeatSummary(preset.rule)
    }

    private func choose(_ next: RepeatRule?) {
        touched = true
        draft = next
    }

    private func finish() {
        let outcome = RepeatSheetOutcome.resolve(
            taskId: taskId,
            wasRepeating: wasRepeating,
            original: RepeatChoice(rule: rule, repeatFrom: repeatFrom),
            draft: RepeatChoice(rule: draft, repeatFrom: draftFrom),
            touched: touched
        )
        switch outcome {
        case .unchanged:
            break
        case let .commit(next, from):
            onCommit(next, from)
        case let .stopRepeating(id):
            raised = .stopRepeating(taskId: id)
        case let .editRepeating(id, edit):
            store.stashRepeatingEdit(taskId: id, edit)
            raised = .editRepeating(taskId: id)
        }
        dismiss()
    }
}

/// The rule the task has now: what it reads as, its settings line and,
/// for a count-limited series, how far it has run.
private struct RepeatCurrentSection: View {
    let rule: RepeatRule?
    let repeatFrom: String?

    var body: some View {
        Section(TasksCopy.currentRepeat) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Label(rule.map(TasksCopy.repeatSummary) ?? TasksCopy.repeats, systemImage: "repeat")
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                if let rule {
                    Text(TasksCopy.repeatInfoLine(rule, repeatFrom: repeatFrom))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    if rule.endType == "count", let total = rule.endCount, total > 0 {
                        Text(TasksCopy.repeatProgress(done: rule.completedCount, total: total))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Task.repeatMark.color)
                            .accessibilityIdentifier("tasks.repeat.progress")
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tasks.repeat.current")
        }
    }
}

extension View {
    /// TP045 — hosts the Stop Repeating / Edit Repeating dialogs the store raises.
    func repeatPrompts(store: TasksStore) -> some View {
        modifier(RepeatPromptsHost(store: store))
    }
}
