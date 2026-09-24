import MemryCore
import SwiftUI

// TP043. The detail's tags, after desktop's `TagAutocomplete`: the task's tags
// as chips with a remove control, a field that adds on return, and while it
// has focus a list of tags this vault's tasks already use (the most used with
// an empty field, matches while typing) plus "Create" for a new one.

struct TaskDetailTags: View {
    let task: TaskItem
    let store: TasksStore

    @State private var input = ""
    @FocusState private var focused: Bool

    var body: some View {
        Section {
            if !task.tags.isEmpty {
                FlowLayout(spacing: Tokens.Space.small) {
                    ForEach(task.tags, id: \.self) { tag in
                        tagChip(tag)
                    }
                }
                .padding(.vertical, Tokens.Space.tight)
                .accessibilityElement(children: .contain)
            }
            TextField(TasksCopy.Detail.addTags, text: $input)
                .font(Tokens.Typography.body.font)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { add(input) }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.detail.tagField")
            if focused {
                suggestions
            }
        } header: {
            Text(TasksCopy.Detail.tags)
        }
    }

    private func tagChip(_ tag: String) -> some View {
        Button {
            Task { await store.detailRemoveTag(task, tag) }
        } label: {
            HStack(spacing: Tokens.Space.tight) {
                TaskTagChip(tag: tag)
                Image(systemName: "xmark")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TasksCopy.Detail.removeTag(tag))
        .accessibilityIdentifier("tasks.detail.tag.\(tag)")
    }

    @ViewBuilder
    private var suggestions: some View {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = store.detailTagSuggestions(query: trimmed, excluding: task.tags)
        ForEach(matches, id: \.self) { tag in
            Button {
                add(tag)
            } label: {
                HStack {
                    TaskTagChip(tag: tag)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("tasks.detail.tagSuggestion.\(tag)")
        }
        if !trimmed.isEmpty, !exists(trimmed, among: matches) {
            Button {
                add(trimmed)
            } label: {
                Label {
                    Text("\(TasksCopy.Detail.createTag) \(trimmed)")
                } icon: {
                    Image(systemName: "plus")
                }
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("tasks.detail.tagCreate")
        }
    }

    private func exists(_ tag: String, among matches: [String]) -> Bool {
        (task.tags + matches).contains { $0.caseInsensitiveCompare(tag) == .orderedSame }
    }

    private func add(_ tag: String) {
        input = ""
        let current = store.items[task.id] ?? task
        Task { await store.detailAddTag(current, tag) }
    }
}
