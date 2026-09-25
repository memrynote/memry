import MemryCore
import SwiftUI

// IB16. Select mode (Paper 16): the title counts the selection, "Select all"
// and a prominent checkmark take the bar, rows show selection circles, and a
// glass bottom toolbar with File / Tag / Snooze / Archive replaces the tab
// bar. Archive all asks first (desktop `archive-confirmation-dialog.tsx`).
// The AI cluster pill is not shown: its inputs never reach iOS (D5).

struct InboxSelectionToolbar: ToolbarContent {
    let store: InboxStore
    @Binding var selection: Set<String>
    @Binding var sheets: InboxSheets
    let finish: () -> Void

    /// One item, so the four actions share one glass capsule (Paper 16,
    /// the Tasks selection bar).
    var body: some ToolbarContent {
        ToolbarItem(placement: .bottomBar) {
            let ids = Array(selection)
            HStack(spacing: 0) {
                Button { sheets.file = InboxFileRequest(ids: ids) } label: {
                    TaskBulkActionLabel(title: InboxCopy.file, systemImage: "folder")
                }
                .accessibilityIdentifier("inbox.bulk.file")
                .frame(maxWidth: .infinity)
                Button { sheets.tag = InboxIdList(ids: ids) } label: {
                    TaskBulkActionLabel(title: InboxCopy.tag, systemImage: "tag")
                }
                .accessibilityIdentifier("inbox.bulk.tag")
                .frame(maxWidth: .infinity)
                Menu {
                    InboxSnoozeMenuItems(now: store.clock()) { date in
                        Task {
                            await store.snooze(ids, until: date)
                            finish()
                        }
                    } pickDate: {
                        sheets.snooze = InboxIdList(ids: ids)
                    }
                } label: {
                    TaskBulkActionLabel(title: InboxCopy.snooze, systemImage: "alarm")
                }
                .accessibilityIdentifier("inbox.bulk.snooze")
                .frame(maxWidth: .infinity)
                Button { sheets.archiveAll = ids } label: {
                    TaskBulkActionLabel(title: InboxCopy.archive, systemImage: "archivebox")
                }
                .accessibilityIdentifier("inbox.bulk.archive")
                // On the button, so the popover points at it.
                .confirmationDialog(
                    InboxCopy.archiveDialogTitle(sheets.archiveAll?.count ?? 0),
                    isPresented: Binding(get: { sheets.archiveAll != nil }, set: { if !$0 { sheets.archiveAll = nil } }),
                    titleVisibility: .visible
                ) {
                    Button(InboxCopy.archiveDialogConfirm(sheets.archiveAll?.count ?? 0), role: .destructive) {
                        if let ids = sheets.archiveAll {
                            Task {
                                await store.archive(ids)
                                finish()
                            }
                        }
                        sheets.archiveAll = nil
                    }
                } message: {
                    Text(InboxCopy.archiveDialogBody)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .disabled(ids.isEmpty)
        }
    }
}

/// Tag all (desktop `bulk-tag-popover.tsx`): type or pick tags, apply.
struct InboxTagSheet: View {
    let store: InboxStore
    let ids: [String]
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var chosen: [String] = []
    @State private var known: [String] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField(InboxCopy.addTagsPlaceholder, text: $text)
                        .textInputAutocapitalization(.never)
                        .onSubmit(add)
                        .accessibilityIdentifier("inbox.tag.field")
                    ForEach(chosen, id: \.self) { tag in
                        Label("#\(tag)", systemImage: "checkmark")
                    }
                }
                Section(InboxCopy.tags) {
                    ForEach(known.filter { !chosen.contains($0) && (text.isEmpty || $0.localizedCaseInsensitiveContains(text)) }, id: \.self) { tag in
                        Button("#\(tag)") { chosen.append(tag) }
                            .foregroundStyle(Tokens.Text.primary.color)
                    }
                }
            }
            .navigationTitle(InboxCopy.tagItems(ids.count))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(InboxCopy.close, systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: InboxCopy.applyTo(ids.count), isEnabled: !chosen.isEmpty || !text.isEmpty) {
                        add()
                        let tags = chosen
                        dismiss()
                        Task { await store.tag(ids, tags: tags) }
                    }
                }
            }
            .task {
                let inboxTags = await store.read { try $0.tags() } ?? []
                let noteTags: [TagSummary] = if let notes = store.notes {
                    (try? await store.executorRun { try notes.tags() }) ?? []
                } else { [] }
                known = Array(Set(inboxTags.map(\.itemType) + noteTags.map(\.name))).sorted()
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func add() {
        let tag = text.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        text = ""
        if !tag.isEmpty, !chosen.contains(tag) { chosen.append(tag) }
    }
}
