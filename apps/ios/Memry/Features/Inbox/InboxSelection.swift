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

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .bottomBar) {
            let ids = Array(selection)
            Button(InboxCopy.file, systemImage: "folder") { sheets.file = InboxFileRequest(ids: ids) }
                .disabled(ids.isEmpty)
                .accessibilityIdentifier("inbox.bulk.file")
            Spacer()
            Button(InboxCopy.tag, systemImage: "number") { sheets.tag = InboxIdList(ids: ids) }
                .disabled(ids.isEmpty)
                .accessibilityIdentifier("inbox.bulk.tag")
            Spacer()
            Menu {
                InboxSnoozeMenuItems(now: store.clock()) { date in
                    Task {
                        await store.snooze(ids, until: date)
                        finish()
                    }
                } pickDate: {
                    sheets.snoozeIds = ids
                }
            } label: {
                Label(InboxCopy.snooze, systemImage: "moon.zzz")
            }
            .disabled(ids.isEmpty)
            .accessibilityIdentifier("inbox.bulk.snooze")
            Spacer()
            Button(InboxCopy.archive, systemImage: "archivebox") { sheets.archiveAll = ids }
                .disabled(ids.isEmpty)
                .accessibilityIdentifier("inbox.bulk.archive")
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
