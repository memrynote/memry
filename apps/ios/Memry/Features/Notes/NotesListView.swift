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
// **Read-only, for now and for one reason.** `Notes` exports `folders`,
// `list` and `read`; the CRUD T126 built in Rust never reached the FFI, so
// there is no menu, no swipe action and no create button here. It is not a
// product decision — the calls do not exist — and the affordances land the
// moment they do.
//
// **`List`, not a `LazyVStack` in a `ScrollView`.** The list is the screen, so
// it takes the platform's own container: row recycling for a vault holding
// thousands, the search field's scroll-edge behaviour, swipe actions when the
// writes land, and the VoiceOver rotor — none of which a hand-rolled stack
// gets. The hierarchy is flattened in `BrowseRows.swift` and rendered as one
// flat list, so opening a folder costs no FFI crossing and no re-layout of
// anything above it.
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
    /// Which folders are open. Held by the screen rather than by the view
    /// model: it is where the user is looking, not what the vault contains,
    /// and a reload must not close what they opened.
    @State private var expanded: Set<String> = []
    @State private var sort: BrowseSort = .modified
    @State private var query = ""

    /// The production entry point: an opened `Vault` and the shell's one core
    /// queue. `State(initialValue:)` so the model outlives a re-render — a
    /// model minted in `body` would re-read the whole vault on every frame.
    init(
        vault: Vault,
        title: String,
        executor: CoreExecutor,
        filler: (any VaultFilling)? = nil,
        store: (any SecureStore)? = nil,
        switchVault: (() -> Void)? = nil
    ) {
        self.title = title
        self.switchVault = switchVault
        _model = State(
            initialValue: VaultBrowseViewModel(
                vault: vault,
                executor: executor,
                filler: filler,
                store: store
            )
        )
    }

    init(model: VaultBrowseViewModel, title: String, switchVault: (() -> Void)? = nil) {
        self.title = title
        self.switchVault = switchVault
        _model = State(initialValue: model)
    }

    var body: some View {
        NavigationStack(path: $path) {
            VaultBrowseScreen(model: model, expanded: $expanded, sort: sort, query: query)
                .navigationTitle(title)
                // The platform's search field: it owns the scroll-edge
                // treatment, the cancel button and the keyboard, and on this
                // OS it is glass without anything here asking for it.
                .searchable(text: $query, prompt: "Search notes")
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
                    // T237. The filler travels with the reader, so a note
                    // whose body the thirty-day window left behind has a way
                    // to fetch it rather than rendering as an empty note.
                    // A wiki link inside a note pushes through this same
                    // registration rather than declaring one of its own: the
                    // rule above is exactly why the read screen is handed a
                    // push instead of owning a destination.
                    NoteReadView(
                        route: route,
                        reader: model.reader,
                        filler: model.filler,
                        editor: model.editor,
                        metadataWriter: model.metadataWriter,
                        writer: model.writer,
                        search: model.searcher,
                        open: { path.append($0) },
                        openTag: { path.append(TagRoute(name: $0)) },
                        noteTasks: model.noteTasks
                    )
                }
                // N600, registered on the root for the same reason the two
                // above are: a `#tag` tapped deep in a note, and a restored
                // path pointing at a tag, both resolve here.
                .navigationDestination(for: TagRoute.self) { route in
                    TaggedNotesView(
                        tag: route.name,
                        reader: model.reader,
                        open: { path.append($0) }
                    )
                }
                .toolbar {
                    if model.writer != nil {
                        ToolbarItem(placement: .topBarTrailing) {
                            // Shown only where a write can actually happen.
                            // A device with no identity to write under gets no
                            // button rather than a button that fails.
                            Button("New note", systemImage: "square.and.pencil") {
                                Task {
                                    if let id = await model.createNote(in: nil) {
                                        // Straight into the note that was just
                                        // made: a create that leaves the user
                                        // hunting for the row did half a job.
                                        path.append(NoteRoute(id: id))
                                    }
                                }
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        // Its own view, and not inline: `body` must stay free
                        // of every iterating container, because that is the
                        // rule the destination registrations above depend on
                        // and a source check enforces it literally.
                        SortMenu(sort: $sort)
                    }
                    if let switchVault {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Switch vault", systemImage: "lock.square") { switchVault() }
                        }
                    }
                }
                .task { await model.loadIfNeeded() }
                // A failed write is an alert over a screen that still holds
                // the vault, not a replacement for it: the outline is still
                // true, only the write did not happen.
                .alert(
                    model.writeFailure?.title ?? "",
                    isPresented: Binding(
                        get: { model.writeFailure != nil },
                        set: { if !$0 { model.writeFailure = nil } }
                    )
                ) {
                    Button("OK", role: .cancel) { model.writeFailure = nil }
                } message: {
                    // What to do next, when there is something to do. A
                    // failure with no guidance says only what happened rather
                    // than inventing a step that does not exist.
                    if let guidance = model.writeFailure?.guidance {
                        Text(guidance)
                    }
                }
        }
    }
}

/// The sort control. Lifted out of `NotesListView.body` on purpose — see the
/// toolbar comment there.
private struct SortMenu: View {
    @Binding var sort: BrowseSort

    var body: some View {
        Menu {
            Picker("Sort by", selection: $sort) {
                ForEach(BrowseSort.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
        } label: {
            Label("Sort by", systemImage: "arrow.up.arrow.down")
        }
    }
}

/// The root of the stack. Every phase is a distinct render.
private struct VaultBrowseScreen: View {
    let model: VaultBrowseViewModel
    @Binding var expanded: Set<String>
    let sort: BrowseSort
    let query: String

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                // Words, never a bare spinner, and never a duration.
                ProgressView { Text("Reading this vault") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .empty:
                EmptyVaultNotice()
            case let .unreadable(error):
                VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                    ErrorNotice(error: error, code: nil)
                    Button("Try again") { Task { await model.reload() } }
                        .memrySecondaryAction()
                }
                .padding(.horizontal, Tokens.Space.screenInline)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            case let .ready(outline):
                VaultOutlineList(
                    outline: outline,
                    expanded: $expanded,
                    sort: sort,
                    query: query,
                    model: model
                )
            }
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
    }
}

/// The hierarchy itself, as one flat platform list.
///
/// **Searching replaces the tree.** A filtered tree either hides a match whose
/// parent does not match or keeps parents that match nothing; a flat list of
/// hits says where the notes are without either lie.
private struct VaultOutlineList: View {
    let outline: VaultOutline
    @Binding var expanded: Set<String>
    let sort: BrowseSort
    let query: String
    /// Carried down for the row actions. The rows are where a rename, a move
    /// or a delete starts, and each one needs the writer behind them.
    let model: VaultBrowseViewModel

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        List {
            if isSearching {
                // The index answers when it can. It reads bodies as well as
                // titles, which is the whole point: a vault holding the word
                // in a note's text used to answer "no results".
                SearchResultsSection(
                    query: query,
                    search: model.search,
                    outline: outline,
                    sort: sort,
                    model: model,
                    toggle: toggle
                )
            } else {
                ForEach(outline.browseRows(expanded: expanded, sort: sort)) { row in
                    BrowseRowView(row: row, toggle: toggle, model: model)
                }
                if !outline.unplacedNotes.isEmpty {
                    // Kaan's spec-defect 124 decision, named on screen rather
                    // than papered over. These notes are real; their folder
                    // carries no `folder_config` row, so the tree above cannot
                    // contain them.
                    Section {
                        ForEach(outline.unplacedRows(sort: sort)) { row in
                            BrowseRowView(row: row, toggle: toggle, model: model)
                        }
                    } header: {
                        Text("Outside the folder list")
                    } footer: {
                        Text("These notes are in folders this vault has no folder record for.")
                    }
                }
            }
        }
        .listStyle(.plain)
        .calmAnimation(.fast, value: expanded)
        // Once per screen, before the first query: an index that was never
        // built answers nothing, and a user cannot tell that from an empty
        // vault.
        .task { await model.search?.prepare() }
        .onChange(of: query) { _, latest in model.search?.run(latest) }
    }

    private func toggle(_ path: String) {
        if expanded.contains(path) { expanded.remove(path) } else { expanded.insert(path) }
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
                    NoteRowLabel(row: .note(note), note: note)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
