import Foundation
import MemryCore
import SwiftUI

// T156. The browse surface: one opened vault's folders and notes, read-only.
//
// **`navigationDestination` is registered on the stack's root content and
// nowhere else** (research R15). A destination declared inside a `List`'s rows
// or a `LazyVStack` is registered only when that row is realised, so a deep
// link or a restored path resolves against a stack that has not heard of the
// route and silently does nothing. One registration on the root covers every
// push in the stack, at any depth, before a single row exists. The note rows
// below are deliberately in a `LazyVStack` — a vault can hold thousands — and
// the registration is outside it, in `body`, which is what makes the rule
// load-bearing here rather than decorative.
//
// **Tokens only** (T160), logical edges only, Dynamic Type from the type
// roles, and reduce-motion branched inside `calmAnimation` on every evaluation
// rather than read once into a flag.
//
// **Read-only.** `Notes` exports `folders`, `list` and `read`; the CRUD T126
// built in Rust never reached the FFI, so there is no menu, no swipe action
// and no create button anywhere in this feature. T156a is cut.
//
// **The folder tree shows only configured folders** (spec-defect 124, Kaan's
// decision), and the notes in an unconfigured folder are still shown — in
// their own section, named for what is actually true about them. See
// `FolderTree.swift`.

struct NotesListView: View {
    let title: String
    /// T155's switch, preserved. `nil` when the account holds one vault and
    /// there is nothing to switch to.
    let switchVault: (() -> Void)?

    @State private var model: VaultBrowseViewModel
    /// A type-erased path rather than `[FolderRoute]`, because T157 added a
    /// second route type to the same stack. `NavigationPath` is what holds
    /// both, and it is still `Codable`-restorable, which is what research
    /// R15's rule is written for.
    @State private var path = NavigationPath()

    /// The production entry point: an opened `Vault` and the shell's one core
    /// queue. `State(initialValue:)` so the model outlives a re-render — a
    /// model minted in `body` would re-read the whole vault on every frame.
    init(vault: Vault, title: String, executor: CoreExecutor, switchVault: (() -> Void)? = nil) {
        self.title = title
        self.switchVault = switchVault
        _model = State(initialValue: VaultBrowseViewModel(vault: vault, executor: executor))
    }

    init(model: VaultBrowseViewModel, title: String, switchVault: (() -> Void)? = nil) {
        self.title = title
        self.switchVault = switchVault
        _model = State(initialValue: model)
    }

    var body: some View {
        NavigationStack(path: $path) {
            VaultBrowseScreen(model: model)
                .navigationTitle(title)
                .navigationDestination(for: FolderRoute.self) { route in
                    FolderScreen(route: route, outline: model.outline)
                }
                // T157, and the **second and last** registration in this
                // stack. It is here, on the stack's root content, and not in
                // `NoteRowsView` — whose lazy stack is exactly the container
                // research R15's rule is about. A note row is realised lazily
                // and appears in two different screens; a destination declared
                // beside it would be registered only once one of those rows
                // had been drawn, so a restored path pointing at a note would
                // resolve against a stack that had never heard of the route
                // and would silently do nothing.
                .navigationDestination(for: NoteRoute.self) { route in
                    NoteReadView(route: route, reader: model.reader)
                }
                .toolbar {
                    if let switchVault {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Switch vault", systemImage: "lock.square") { switchVault() }
                        }
                    }
                }
                .task { await model.loadIfNeeded() }
        }
    }
}

/// The root of the stack. Every phase is a distinct render.
private struct VaultBrowseScreen: View {
    let model: VaultBrowseViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                switch model.phase {
                case .loading:
                    // Words, never a bare spinner, and never a duration.
                    ProgressView { Text("Reading this vault") }
                        .progressViewStyle(.circular)
                        .font(Tokens.Typography.supporting.font)
                        .tint(Tokens.Text.secondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .empty:
                    EmptyVaultNotice()
                case let .unreadable(error):
                    ErrorNotice(error: error, code: nil)
                    Button("Try again") { Task { await model.reload() } }
                        .memrySecondaryAction()
                case let .ready(outline):
                    VaultOutlineView(outline: outline)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
    }
}

/// The hierarchy itself. Same shape as desktop's — the folder tree first, then
/// the notes that sit at the vault root.
private struct VaultOutlineView: View {
    let outline: VaultOutline

    var body: some View {
        let folders = outline.folderRows
        if !folders.isEmpty {
            BrowseSection(title: "Folders") { FolderTreeView(rows: folders) }
        }
        if !outline.rootNotes.isEmpty {
            BrowseSection(title: "Notes") { NoteRowsView(notes: outline.rootNotes) }
        }
        if !outline.unplacedNotes.isEmpty {
            // Kaan's spec-defect 124 decision, named on screen rather than
            // papered over. These notes are real; their folder carries no
            // `folder_config` row, so the tree above cannot contain it.
            BrowseSection(
                title: "Outside the folder list",
                caption: "These notes are in folders this vault has no folder record for."
            ) {
                NoteRowsView(notes: outline.unplacedNotes)
            }
        }
    }
}

/// A vault that really holds nothing.
///
/// Not the same screen as a read that failed, and it promises no mechanism
/// this build has: there is no note creation on iOS, so it offers none
/// (`DESIGN.md` §"Error copy, in detail", spec-defect 111).
private struct EmptyVaultNotice: View {
    var body: some View {
        ContentUnavailableView {
            Label("No notes in this vault", systemImage: "tray")
        } description: {
            Text("This phone holds no notes and no folders for this vault yet.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One titled group.
struct BrowseSection<Content: View>: View {
    let title: String
    var caption: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(title)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            if let caption {
                Text(caption)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            content()
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The note rows. Lazy on purpose — a real vault holds thousands — which is
/// exactly why no `navigationDestination` may live in here.
struct NoteRowsView: View {
    let notes: [NoteSummary]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: Tokens.Space.tight) {
            ForEach(notes, id: \.id) { note in
                // `NavigationLink(value:)` and not `NavigationLink(destination:)`:
                // a value push resolves against the **one** registration in
                // `NotesListView.body`, which is what lets a restored path
                // reach the same screen without a row existing. A destination
                // built here would be a second, lazily-registered one.
                NavigationLink(value: NoteRoute(id: note.id)) {
                    NoteRowLabel(note: note)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One note.
///
/// The label only. T157 landed the reading surface, so `NoteRowsView` wraps
/// this in a `NavigationLink(value:)` whose destination is registered once, in
/// `NotesListView.body`. The wrapping is there and not here so that this type
/// stays a pure label — the folder tree renders the same rows.
private struct NoteRowLabel: View {
    let note: NoteSummary

    /// Never empty and never the id: an id identifies content and reads as
    /// noise, so an untitled note says so in words.
    private var title: String { note.title.isEmpty ? "Untitled note" : note.title }

    /// `nil` means the payload carried no such instant, never "zero"
    /// (data-model §A.6). An absent date is rendered as nothing rather than as
    /// an epoch nobody wrote.
    private var modified: String? {
        guard let milliseconds = note.modifiedAt else { return nil }
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(note.emoji ?? "")
                .font(Tokens.Typography.body.font)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(note.title.isEmpty
                        ? Tokens.Text.secondary.color
                        : Tokens.Text.primary.color)
                if let modified {
                    Text(modified)
                        .font(Tokens.Typography.caption.font.monospacedDigit())
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
            Spacer(minLength: Tokens.Space.tight)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .blockSurface(radius: Tokens.Radius.control)
        .multilineTextAlignment(.leading)
        .accessibilityElement(children: .combine)
    }
}
