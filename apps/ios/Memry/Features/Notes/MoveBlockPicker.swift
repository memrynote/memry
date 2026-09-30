import MemryCore
import SwiftUI

// Desktop's block menu "Move to" (`move-block-dialog.tsx`): choose the note a
// block moves into; it is appended to the end of that note's body. Opened from
// the keyboard toolbar's `...` menu through `EditorSession.moveRequest`.
//
// Deliberately no "create a new note" row, as on desktop: moving and creating
// are two failure points, and a failed create would leave the block in limbo.

/// Presents the picker for the session's pending Move to, and the alert when
/// one did not land.
struct MoveBlockPresenter: ViewModifier {
    let session: EditorSession
    /// Every note in the vault, most recently modified first.
    let notes: [NoteSummary]
    /// The note the block moves out of; never offered as a target.
    let currentNoteId: String

    func body(content: Content) -> some View {
        content
            .sheet(item: Binding(
                get: { session.moveRequest },
                set: { if $0 == nil { session.cancelMoveToNote() } }
            )) { _ in
                MoveBlockPicker(notes: notes.filter { $0.id != currentNoteId }) { target in
                    session.moveToNote(target)
                }
            }
            .alert(
                session.moveFailure?.title ?? "",
                isPresented: Binding(
                    get: { session.moveFailure != nil },
                    set: { if !$0 { session.moveFailure = nil } }
                )
            ) {
                Button("OK", role: .cancel) { session.moveFailure = nil }
            } message: {
                Text(session.moveFailure?.guidance ?? "")
            }
    }
}

/// A searchable list of the vault's notes.
struct MoveBlockPicker: View {
    let notes: [NoteSummary]
    let pick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    /// Title or folder containing the query, in the list's own order.
    static func matches(_ notes: [NoteSummary], query: String) -> [NoteSummary] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return notes }
        return notes.filter {
            $0.title.localizedStandardContains(trimmed) || ($0.folderPath?.localizedStandardContains(trimmed) ?? false)
        }
    }

    var body: some View {
        let results = Self.matches(notes, query: query)
        NavigationStack {
            List(results, id: \.id) { note in
                Button {
                    pick(note.id)
                    dismiss()
                } label: {
                    HStack(spacing: Tokens.Space.small) {
                        Group {
                            if let emoji = ProjectIconValue.emoji(note.emoji) {
                                Text(emoji)
                            } else {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(Tokens.Text.secondary.color)
                            }
                        }
                        .frame(width: Tokens.Space.inset)
                        .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(note.title.isEmpty ? "Untitled" : note.title)
                                .lineLimit(1)
                            if let folder = note.folderPath, !folder.isEmpty {
                                Text(folder)
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(Tokens.Text.secondary.color)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Moves the block to the end of this note")
            }
            .overlay {
                if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search notes")
            .navigationTitle("Move to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .foregroundStyle(Tokens.Text.primary.color)
    }
}
