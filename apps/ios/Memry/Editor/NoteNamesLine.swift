import SwiftUI

/// A note's other names (`aliases`) under its title, as desktop's
/// `NoteNamesLine`: "also A · B". A name opens a field to change or remove it;
/// adding comes from the page's quiet `+ Name` row, through `adding`.
struct NoteNamesLine: View {
    let names: [String]
    /// `nil` draws the line read-only.
    let write: (([String]) -> Void)?
    @Binding var adding: Bool

    /// The name being edited, or `nil` while adding.
    @State private var editing: String?
    @State private var draft = ""

    private var prompting: Binding<Bool> {
        Binding(
            get: { adding || editing != nil },
            set: { shown in
                if !shown {
                    adding = false
                    editing = nil
                }
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !names.isEmpty { line }
        }
        .onChange(of: adding) { _, isAdding in
            if isAdding { draft = "" }
        }
        .alert(editing == nil ? "Add another name" : "Edit name", isPresented: prompting) {
            TextField("Another name", text: $draft)
                .accessibilityLabel("Another name for this note")
            Button("Save") { commit(draft) }
            if editing != nil {
                Button("Remove", role: .destructive) { commit("") }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A link to this name opens this note.")
        }
    }

    private var line: some View {
        FlowLayout(spacing: Tokens.Space.tight) {
            Text("also")
                .foregroundStyle(Tokens.Text.tertiary.color)
            ForEach(Array(names.enumerated()), id: \.element) { index, name in
                if index > 0 {
                    Text("·")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .accessibilityHidden(true)
                }
                if write != nil {
                    Button(name) {
                        draft = name
                        editing = name
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityLabel("Edit or remove the name \(name)")
                } else {
                    Text(name).foregroundStyle(Tokens.Text.secondary.color)
                }
            }
        }
        .font(Tokens.Typography.caption.font)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("note.names")
    }

    private func commit(_ typed: String) {
        let next = NoteNames.replacing(editing, with: typed, in: names)
        adding = false
        editing = nil
        if next != names { write?(next) }
    }
}

/// The list edits the names line makes. The core normalizes what is stored
/// (trim, dedupe by name key, drop the title), so these only place the edit.
enum NoteNames {
    /// `old == nil` adds `typed` at the end; an empty `typed` removes `old`;
    /// otherwise `typed` takes `old`'s place.
    static func replacing(_ old: String?, with typed: String, in names: [String]) -> [String] {
        let value = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let old else { return value.isEmpty ? names : names + [value] }
        guard let index = names.firstIndex(of: old) else { return names }
        var next = names
        if value.isEmpty {
            next.remove(at: index)
        } else {
            next[index] = value
        }
        return next
    }
}
