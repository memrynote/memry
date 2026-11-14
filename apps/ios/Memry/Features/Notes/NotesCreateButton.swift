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
// are also the button's accessibility actions. The tip shows only while the
// button is on screen: the tap that earns it also opens the new note, and a
// popover left behind would point at nothing (#4341).

struct NotesCreateButton: View {
    let newNote: () -> Void
    let newFolder: () -> Void
    /// `nil` hides "From template" (no templates, or no way to write one).
    var fromTemplate: (() -> Void)?
    /// In the split view's list column toolbar (`DESIGN.md` › Tablet, D4):
    /// `square.and.pencil`, drawn by the toolbar rather than as a glass disc.
    var inToolbar = false

    private let tip = NotesCreateTip()
    @State private var isOnScreen = false

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
            if inToolbar {
                Image(systemName: "square.and.pencil")
            } else {
                Image(systemName: "plus")
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .padding(Tokens.Space.small)
            }
        } primaryAction: {
            // Off before the donation makes the tip eligible: shown during the
            // push, it would count as its one display and then vanish.
            isOnScreen = false
            newNote()
            Task { await NotesCreateTip.madeNote.donate() }
        }
        .modifier(FloatingCreateStyle(isOn: !inToolbar))
        .popoverTip(isOnScreen ? tip : nil, arrowEdge: .bottom)
        .onAppear { isOnScreen = true }
        .onDisappear { isOnScreen = false }
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

/// The floating disc's look, which a toolbar button leaves to the toolbar.
private struct FloatingCreateStyle: ViewModifier {
    let isOn: Bool

    func body(content: Content) -> some View {
        if isOn {
            content
                .menuStyle(.button)
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
        } else {
            content
        }
    }
}

extension View {
    /// A Notes list's create control and the dialogs behind it: the floating
    /// "+" at compact width, the list column's toolbar button inside the split
    /// view (D4). Hidden when the device has no identity to write under.
    /// `folderPath` is where a new note or folder goes (`nil`: the vault root),
    /// `place` names it in the new-folder dialog, and `open` shows what a
    /// create made.
    func notesCreate(
        _ model: VaultBrowseViewModel,
        in folderPath: String?,
        place: String,
        open: @escaping (String) -> Void
    ) -> some View {
        modifier(NotesCreateControl(model: model, folderPath: folderPath, place: place, open: open))
    }
}

private struct NotesCreateControl: ViewModifier {
    let model: VaultBrowseViewModel
    let folderPath: String?
    let place: String
    let open: (String) -> Void
    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?
    @State private var isNamingFolder = false
    @State private var draftFolderName = ""
    @State private var isPickingTemplate = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                if split != nil, model.writer != nil {
                    ToolbarItem(placement: .topBarTrailing) { button(inToolbar: true) }
                }
            }
            // The page's "+", in the bottom trailing slot every page's "+"
            // uses: tap for a note, hold for a folder.
            .overlay(alignment: .bottomTrailing) {
                if split == nil, model.writer != nil {
                    button(inToolbar: false)
                        .padding(.horizontal, Tokens.Space.inset)
                        .padding(.bottom, Tokens.Space.medium)
                }
            }
            .fromTemplateSheet(isPresented: $isPickingTemplate, browse: model, folderPath: folderPath, open: open)
            .alert("New folder", isPresented: $isNamingFolder) {
                TextField("Name", text: $draftFolderName)
                Button("Create") {
                    let name = draftFolderName
                    Task { await model.createFolder(named: name, in: folderPath) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(place)
            }
    }

    private func button(inToolbar: Bool) -> some View {
        NotesCreateButton(
            newNote: {
                Task {
                    // Straight into the note that was just made: a create
                    // that leaves the user hunting for the row did half a job.
                    if let id = await model.createNote(in: folderPath) { open(id) }
                }
            },
            newFolder: {
                draftFolderName = ""
                isNamingFolder = true
            },
            fromTemplate: { isPickingTemplate = true },
            inToolbar: inToolbar
        )
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
/// capture's "View"), or a note to make there (⌘N). The Notes page owns its
/// stack and its model, so it takes the request.
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

    /// ⌘N asked the Notes page for a new note, which it makes with its own
    /// model so its list shows the row.
    private(set) var newNoteRequested = false

    func requestNewNote() { newNoteRequested = true }

    func takeNewNote() -> Bool {
        defer { newNoteRequested = false }
        return newNoteRequested
    }
}
