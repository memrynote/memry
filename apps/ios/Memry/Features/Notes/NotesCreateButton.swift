import SwiftUI
import TipKit

// The Notes page's "+", in the bottom trailing slot every page's "+" uses.
//
// **Tap makes a note, hold opens the menu.** A note is what the page makes
// most, so it takes one tap; a folder or a note from a template is the menu
// behind a hold (`Menu(primaryAction:)`, the system's own pattern).
//
// **A hold is invisible, so it is taught once.** `NotesCreateTip` points at
// the button after the first note made with it, and never again once the
// menu has been used. VoiceOver cannot discover a hold: the menu's entries
// are also the button's accessibility actions.

struct NotesCreateButton: View {
    let newNote: () -> Void
    let newFolder: () -> Void
    /// `nil` hides "From template" (no templates, or no way to write one).
    var fromTemplate: (() -> Void)?

    private let tip = NotesCreateTip()

    var body: some View {
        Menu {
            Button(NotesCreateCopy.newNote, systemImage: "square.and.pencil") { newNote() }
                .accessibilityIdentifier("notes.create.note")
            Button(NotesCreateCopy.newFolder, systemImage: "folder.badge.plus") { usedMenu(newFolder) }
                .accessibilityIdentifier("notes.create.folder")
            if let fromTemplate {
                Button(NotesCreateCopy.fromTemplate, systemImage: "doc.on.doc") { usedMenu(fromTemplate) }
                    .accessibilityIdentifier("notes.create.template")
            }
        } label: {
            Image(systemName: "plus")
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .padding(Tokens.Space.small)
        } primaryAction: {
            newNote()
            Task { await NotesCreateTip.madeNote.donate() }
        }
        .menuStyle(.button)
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .popoverTip(tip, arrowEdge: .bottom)
        .accessibilityLabel(NotesCreateCopy.newNote)
        .accessibilityHint(NotesCreateCopy.holdHint)
        .accessibilityAction(named: NotesCreateCopy.newFolder) { usedMenu(newFolder) }
        .accessibilityActions {
            if let fromTemplate {
                Button(NotesCreateCopy.fromTemplate) { usedMenu(fromTemplate) }
            }
        }
        .accessibilityIdentifier("notes.addButton")
    }

    /// The menu was found: the tip has nothing left to teach.
    private func usedMenu(_ action: () -> Void) {
        tip.invalidate(reason: .actionPerformed)
        action()
    }
}

/// "Hold + for more", shown once, after the first note made with the "+".
struct NotesCreateTip: Tip {
    static let madeNote = Event(id: "notes.create.madeNote")

    var title: Text { Text(NotesCreateCopy.tipTitle) }
    var message: Text? { Text(NotesCreateCopy.tipMessage) }
    var image: Image? { Image(systemName: "hand.tap") }

    var rules: [Rule] {
        #Rule(Self.madeNote) { $0.donations.count >= 1 }
    }

    var options: [any TipOption] { [MaxDisplayCount(1)] }
}

enum NotesCreateCopy {
    static let newNote = "New note"
    static let newFolder = "New folder"
    static let fromTemplate = "From template…"
    static let holdHint = "Hold for a new folder or a note from a template"
    static let tipTitle = "Hold + for more"
    static let tipMessage = "Make a folder, or start a note from a template."
}

/// A note to open on the Notes page from outside it (a search hit, a
/// capture's "View"). The Notes page owns its stack, so it takes the request.
@MainActor
@Observable
final class NotesLinks {
    static let shared = NotesLinks()
    private(set) var pending: String?

    func open(_ id: String) { pending = id }

    func take() -> String? {
        defer { pending = nil }
        return pending
    }
}
