import MemryCore
import SwiftUI

// TP043. The detail's related items, after the drawer's Related section. The
// core resolves each linked id to present, missing or not on this device
// (canvases: the phone does not sync them, §6 TP027); the section lists them
// in that state, removes one with its own control or a swipe, and adds through
// a search picker.
//
// A present item is shown, not opened: the Notes tab has no route a task
// screen can push onto, so a tap would be a dead control.

struct TaskRelatedSection: View {
    let task: TaskItem
    let store: TasksStore

    @State private var linked: [LinkedItemRecord] = []
    @State private var picking = false

    /// Re-read when either linked id list changes.
    private var key: String {
        (task.linkedNoteIds + ["|"] + task.linkedCanvasIds).joined(separator: ",")
    }

    var body: some View {
        Section {
            ForEach(linked, id: \.self) { item in
                TaskRelatedRow(item: item) {
                    Task { await store.detailRemoveRelated(item, from: store.items[task.id] ?? task) }
                }
            }
            if linked.isEmpty {
                Text(TasksCopy.Detail.noRelatedItems)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        } header: {
            HStack {
                Text(TasksCopy.Detail.related)
                Spacer()
                Button {
                    picking = true
                } label: {
                    Image(systemName: "plus")
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .accessibilityLabel(TasksCopy.Detail.addRelatedItem)
                .accessibilityIdentifier("tasks.detail.addRelated")
            }
        }
        .task(id: key) {
            linked = await store.detailLinkedItems(taskId: task.id)
        }
        .sheet(isPresented: $picking) {
            TaskRelatedPicker(task: store.items[task.id] ?? task, store: store)
        }
    }
}

/// One related item in its state.
struct TaskRelatedRow: View {
    let item: LinkedItemRecord
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            TaskRelatedIcon(kind: kind, emoji: item.item?.emoji)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(item.state == "present" ? Tokens.Text.primary.color : Tokens.Text.tertiary.color)
                    .lineLimit(2)
                if let detail {
                    Text(detail)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                TasksCopy.Detail.removeRelatedItem(item.item?.title ?? TasksCopy.Detail.relatedItemFallback)
            )
            .accessibilityIdentifier("tasks.detail.removeRelated.\(item.id)")
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .swipeActions {
            Button(role: .destructive, action: onRemove) {
                Label(TasksCopy.Detail.removeRelatedItem(title), systemImage: "xmark")
            }
        }
        .accessibilityIdentifier("tasks.detail.related.\(item.id)")
    }

    private var kind: String { item.item?.kind ?? item.field }

    private var title: String {
        switch item.state {
        case "present": item.item?.title ?? TasksCopy.Detail.relatedItemFallback
        case "notOnDevice": TasksCopy.Detail.relatedKind("canvas")
        default: TasksCopy.Detail.relatedItemMissing
        }
    }

    private var detail: String? {
        switch item.state {
        case "present": item.item?.folderPath.flatMap { $0.isEmpty ? nil : $0 }
        case "notOnDevice": TasksCopy.Detail.relatedCanvasElsewhere
        default: nil
        }
    }
}

/// The symbol for a related item's kind (or its emoji).
struct TaskRelatedIcon: View {
    let kind: String
    let emoji: String?

    var body: some View {
        Group {
            if let emoji, !emoji.isEmpty {
                Text(emoji)
            } else {
                Image(systemName: symbol)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        }
        .font(Tokens.Typography.body.font)
        .accessibilityLabel(TasksCopy.Detail.relatedKind(kind))
    }

    private var symbol: String {
        switch kind {
        case "canvas": "pencil.and.scribble"
        case "file": "doc"
        case "journal": "book"
        default: "doc.text"
        }
    }
}

/// Search this vault's notes and files and link one (`drawer.searchRelated`).
struct TaskRelatedPicker: View {
    let task: TaskItem
    let store: TasksStore

    @State private var query = ""
    @State private var results: [RelatedItemRecord] = []
    @State private var searched = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(results, id: \.self) { item in
                    Button {
                        let current = store.items[task.id] ?? task
                        Task {
                            await store.detailAddRelated(item, to: current)
                            dismiss()
                        }
                    } label: {
                        HStack(spacing: Tokens.Space.medium) {
                            TaskRelatedIcon(kind: item.kind, emoji: item.emoji)
                            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                                Text(item.title)
                                    .font(Tokens.Typography.body.font)
                                    .foregroundStyle(Tokens.Text.primary.color)
                                if let folder = item.folderPath, !folder.isEmpty {
                                    Text(folder)
                                        .font(Tokens.Typography.caption.font)
                                        .foregroundStyle(Tokens.Text.tertiary.color)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("tasks.detail.relatedResult.\(item.id)")
                }
                if searched, results.isEmpty {
                    Text(query.isEmpty ? TasksCopy.Detail.noRelatedAvailable : TasksCopy.Detail.noMatchingRelated)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
            .listStyle(.plain)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: TasksCopy.Detail.searchRelated
            )
            .navigationTitle(TasksCopy.Detail.addRelatedItem)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(TasksCopy.Detail.cancel) { dismiss() }
                }
            }
            .task(id: query) {
                // A short pause so typing does not query on every keystroke.
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
                guard !Task.isCancelled else { return }
                results = await store.detailSearchRelated(query, for: task)
                searched = true
            }
        }
        .accessibilityIdentifier("tasks.detail.relatedPicker")
    }
}
