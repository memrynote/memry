import MemryCore
import SwiftUI

// TP043, redesigned (RD08). The detail's "Linked" items (Paper "Related
// (shown only when present)"): nothing at all while the task links nothing;
// linking is the "+" pill's "Link note or file" (artboard 09). The core
// resolves each linked id to present, missing or not on this device
// (canvases: the phone does not sync them, §6 TP027); a row removes by swipe,
// long press or VoiceOver action.
//
// A present note or file is shown, not opened: the Notes tab has no route a
// task screen can push onto, so a tap would be a dead control. A journal day
// opens in the Journal tab (JP052), as desktop's `openRelatedVaultItem` opens
// it by date.

struct TaskRelatedSection: View {
    let task: TaskItem
    let store: TasksStore
    /// Loaded by the detail (`linkedItemsLoader`): an empty section renders
    /// nothing, so a load attached here would never run.
    let linked: [LinkedItemRecord]

    @Environment(\.openJournalDay) private var openJournalDay

    var body: some View {
        Section {
            ForEach(linked, id: \.self) { item in
                TaskRelatedRow(item: item, onRemove: {
                    Task { await store.detailRemoveRelated(item, from: store.items[task.id] ?? task) }
                }, open: journalOpener(item))
                .listRowInsets(SubtaskRow.insets)
            }
        } header: {
            if !linked.isEmpty {
                Text(TasksCopy.Detail.linked)
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .textCase(nil)
                    .padding(.leading, TaskDetailLayout.bodyLeading - TaskLayout.edge)
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }

    /// Opens a present journal item's day, or `nil` for anything else.
    private func journalOpener(_ item: LinkedItemRecord) -> (() -> Void)? {
        guard item.state == "present", let related = item.item, related.kind == "journal",
              let date = JournalLink.date(fromWikiTarget: related.title) ?? JournalLink.date(fromJournalId: related.id),
              let openJournalDay else { return nil }
        return { openJournalDay(date) }
    }
}

extension View {
    /// Re-reads a task's linked items whenever either linked id list changes.
    func linkedItemsLoader(task: TaskItem, store: TasksStore, into linked: Binding<[LinkedItemRecord]>) -> some View {
        let key = (task.linkedNoteIds + ["|"] + task.linkedCanvasIds).joined(separator: ",")
        return self.task(id: "\(task.id)#\(key)") {
            linked.wrappedValue = await store.detailLinkedItems(taskId: task.id)
        }
    }
}

/// One related item in its state.
struct TaskRelatedRow: View {
    let item: LinkedItemRecord
    let onRemove: () -> Void
    /// Opens the item; only a journal day has somewhere to go.
    var open: (() -> Void)?

    var body: some View {
        Group {
            if let open {
                Button(action: open) { row.contentShape(.rect) }
                    .buttonStyle(.plain)
                    .accessibilityHint(JournalCopy.openInJournal)
            } else {
                row
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: TasksCopy.Detail.removeRelatedItem(title), onRemove)
        .swipeActions {
            Button(role: .destructive, action: onRemove) {
                Label(TasksCopy.Detail.removeRelatedItem(title), systemImage: "xmark")
            }
            .accessibilityIdentifier("tasks.detail.removeRelated.\(item.id)")
        }
        .contextMenu {
            Button(
                TasksCopy.Detail.removeRelatedItem(title), systemImage: "xmark", role: .destructive, action: onRemove
            )
        }
        .accessibilityIdentifier("tasks.detail.related.\(item.id)")
    }

    private var row: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            Text(verbatim: "A")
                .font(Tokens.Typography.body.font)
                .hidden()
                .frame(width: TaskLayout.lane)
                .overlay { TaskRelatedIcon(kind: kind, emoji: item.item?.emoji) }
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.label.font.weight(.regular))
                    .foregroundStyle(item.state == "present" ? Tokens.Text.primary.color : Tokens.Text.tertiary.color)
                    .lineLimit(2)
                if let detail {
                    Text(detail)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
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
        // Paper's Linked row is the title alone; the state lines stay.
        case "present": nil
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
                    .foregroundStyle(kind == "note" ? Tokens.Task.tokenNote.color : Tokens.Text.tertiary.color)
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
                    Button(role: .close) { dismiss() }
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
