import MemryCore
import SwiftUI

// TP046. The inline "Add sub-issue…" field (`add-subtask-input.tsx`): Return
// adds and keeps the field focused for the next one; leaving it empty closes it.

struct SubtaskAddField: View {
    let parent: TaskItem
    let store: TasksStore
    @Binding var isActive: Bool

    @State private var title = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "plus")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            TextField(TasksCopy.subtaskAddPlaceholder, text: $title)
                .font(Tokens.Typography.body.font)
                .focused($isFocused)
                .submitLabel(.next)
                .onSubmit(submit)
                .accessibilityLabel(TasksCopy.subtaskAdd)
                .accessibilityIdentifier("tasks.subtasks.addField")
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .onAppear { isFocused = true }
        .onChange(of: isFocused) { _, focused in
            if !focused, title.trimmingCharacters(in: .whitespaces).isEmpty { isActive = false }
        }
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
