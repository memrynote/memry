import MemryCore
import SwiftUI

// TP043. The task description (§5 of the plan): desktop stores a plain
// markdown string and edits it through BlockNote; iOS has no markdown block
// editor, so it edits the raw string in a `TextEditor` and shows a rendered
// preview (`AttributedString(markdown:)`, inline formatting and links, line
// breaks kept), after desktop's `task-description-preview.tsx`.
//
// Saving follows desktop's drawer: edits are debounced (500 ms) so every
// keystroke is not a write, and a pending edit is flushed when editing ends
// or the screen goes away.

struct TaskDescriptionSection: View {
    let task: TaskItem
    let store: TasksStore

    @State private var editing = false
    @State private var draft = ""
    @State private var pending: Task<Void, Never>?
    @FocusState private var focused: Bool

    var body: some View {
        Section {
            if editing {
                editor
            } else {
                preview
            }
        } header: {
            HStack {
                Text(TasksCopy.Detail.descriptionLabel)
                Spacer()
                Button(editing ? TasksCopy.Detail.done : TasksCopy.Detail.edit) {
                    editing ? finish() : start()
                }
                .font(Tokens.Typography.label.font)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.detail.descriptionToggle")
            }
        }
        .onDisappear { flush() }
    }

    private var preview: some View {
        Button(action: start) {
            Group {
                if let text = task.description, !text.isEmpty {
                    Text(TaskDescriptionMarkdown.render(text))
                        .foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    Text(TasksCopy.Detail.descriptionPlaceholder)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
            .font(Tokens.Typography.body.font)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.Detail.descriptionLabel)
        .accessibilityValue(task.description ?? "")
        .accessibilityHint(TasksCopy.Detail.edit)
        .accessibilityIdentifier("tasks.detail.description")
    }

    private var editor: some View {
        TextEditor(text: $draft)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .scrollContentBackground(.hidden)
            .frame(minHeight: Tokens.Size.coverHeight)
            .focused($focused)
            .accessibilityLabel(TasksCopy.Detail.descriptionLabel)
            .accessibilityIdentifier("tasks.detail.descriptionEditor")
            .onChange(of: draft) { _, _ in schedule() }
            .onChange(of: focused) { _, isFocused in
                if !isFocused { flush() }
            }
    }

    private func start() {
        draft = task.description ?? ""
        editing = true
        focused = true
    }

    private func finish() {
        focused = false
        flush()
        editing = false
    }

    private func schedule() {
        pending?.cancel()
        let text = draft
        let id = task.id
        pending = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await store.detailSetDescription(taskId: id, text: text)
        }
    }

    private func flush() {
        pending?.cancel()
        pending = nil
        guard editing else { return }
        let text = draft
        let id = task.id
        Task { await store.detailSetDescription(taskId: id, text: text) }
    }
}

/// The rendered preview of a markdown description.
enum TaskDescriptionMarkdown {
    /// Inline markdown (bold, italic, code, strikethrough, links) with line
    /// breaks kept; a string that does not parse shows as written.
    static func render(_ markdown: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)
    }
}
