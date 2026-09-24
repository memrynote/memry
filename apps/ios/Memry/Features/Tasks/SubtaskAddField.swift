import MemryCore
import SwiftUI

// TP046, redesigned (RD08). The inline "Add subtask" row (Paper "Add subtask
// (inline)", desktop's `add-subtask-input.tsx`): a "+" in the status lane and
// the row's text. Tapping it turns it into a field; Return adds and keeps the
// field focused for the next one; leaving it empty turns it back.

struct SubtaskAddField: View {
    let parent: TaskItem
    let store: TasksStore
    @Binding var isActive: Bool

    @State private var title = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            TaskStatusLane(action: activate, label: TasksCopy.subtaskAdd, identifier: "tasks.subtasks.add") {
                Image(systemName: "plus")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            if isActive {
                TextField(TasksCopy.subtaskAddRow, text: $title)
                    .font(Tokens.Typography.label.font.weight(.regular))
                    .focused($isFocused)
                    .submitLabel(.next)
                    .onSubmit(submit)
                    .accessibilityLabel(TasksCopy.subtaskAdd)
                    .accessibilityIdentifier("tasks.subtasks.addField")
            } else {
                Button(action: activate) {
                    Text(TasksCopy.subtaskAddRow)
                        .font(Tokens.Typography.label.font.weight(.regular))
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tasks.subtasks.addRow")
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .onChange(of: isFocused) { _, focused in
            if !focused, title.trimmingCharacters(in: .whitespaces).isEmpty { isActive = false }
        }
    }

    private func activate() {
        isActive = true
        isFocused = true
    }

    private func submit() {
        let text = title
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            isActive = false
            return
        }
        title = ""
        isFocused = true
        Task { await store.addSubtask(to: parent, title: text) }
    }
}

extension TasksCopy {
    /// `addSubtask2`.
    static let subtaskAddRow = "Add subtask"
}
