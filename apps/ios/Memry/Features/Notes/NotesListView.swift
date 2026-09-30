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
// **Writes go through `NotesWriting`** (`VaultWrite.swift`), and every create,
// rename, move and delete affordance is hidden when `model.writer` is `nil`.
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
    @State private var model: VaultBrowseViewModel
    /// A type-erased path rather than `[FolderRoute]`, because T157 added a
    /// second route type to the same stack. `NavigationPath` is what holds
    /// both, and it is still `Codable`-restorable, which is what research
    /// R15's rule is written for.
    @State private var path = LaunchSnapshot.shared.path("notes")
    /// Which folders are open. Held by the screen rather than by the view
    /// model: it is where the user is looking, not what the vault contains,
    /// and a reload must not close what they opened.
    @State private var expanded: Set<String> = []
    /// The folder last opened or closed. It carries the arrow that pushes the
    /// folder's own screen, as the selected row does in desktop's tree.
    @State private var selectedFolder: String?
    /// Persisted like desktop's Collections sort mode. The raw values are
    /// desktop's mode ids.
    @AppStorage("notes.browseSort") private var sort: BrowseSort = .modifiedNewest
    @State private var isNamingFolder = false
    @State private var draftFolderName = ""
    private let notesLinks = NotesLinks.shared

    /// The production entry point: an opened `Vault` and the shell's one core
    /// queue. `State(initialValue:)` so the model outlives a re-render — a
    /// model minted in `body` would re-read the whole vault on every frame.
    init(
        vault: Vault,
        executor: CoreExecutor,
        filler: (any VaultFilling)? = nil,
        store: (any SecureStore)? = nil
    ) {
        _model = State(
            initialValue: VaultBrowseViewModel(
                vault: vault,
                executor: executor,
                filler: filler,
                store: store
            )
        )
    }

    init(model: VaultBrowseViewModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        NavigationStack(path: $path) {
            VaultBrowseScreen(
                model: model,
                expanded: $expanded,
                selectedFolder: $selectedFolder,
                sort: sort,
                openFolder: { path.append(FolderRoute(path: $0)) },
                openNote: { path.append(NoteRoute(id: $0)) }
            )
                .navigationDestination(for: FolderRoute.self) { route in
                    FolderScreen(
                        route: route,
                        model: model,
                        openFolder: { path.append(FolderRoute(path: $0)) },
                        openNote: { path.append(NoteRoute(id: $0)) }
                    )
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
                    ToolbarItem(placement: .topBarTrailing) {
                        // Its own view, and not inline: `body` must stay free
                        // of every iterating container, because that is the
                        // rule the destination registrations above depend on
                        // and a source check enforces it literally.
                        SortMenu(sort: $sort)
                    }
                    GlobalSearchToolbarItem()
                }
                // The page's "+", in the bottom trailing slot every page's
                // "+" uses: tap for a note, hold for a folder. Shown only
                // where a write can actually happen, and only on the root:
                // a folder's screen carries its own.
                .overlay(alignment: .bottomTrailing) {
                    if model.writer != nil {
                        NotesCreateButton(
                            newNote: {
                                Task {
                                    // Straight into the note that was just
                                    // made: a create that leaves the user
                                    // hunting for the row did half a job.
                                    if let id = await model.createNote(in: nil) { path.append(NoteRoute(id: id)) }
                                }
                            },
                            newFolder: {
                                draftFolderName = ""
                                isNamingFolder = true
                            }
                        )
                        .padding(.horizontal, Tokens.Space.inset)
                        .padding(.bottom, Tokens.Space.medium)
                    }
                }
                .alert("New folder", isPresented: $isNamingFolder) {
                    TextField("Name", text: $draftFolderName)
                    Button("Create") {
                        let name = draftFolderName
                        Task { await model.createFolder(named: name, in: nil) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("At the top of this vault.")
                }
                // A search hit or a capture's "View" opens its note here.
                .onChange(of: notesLinks.pending, initial: true) {
                    if let id = notesLinks.take() { path = NavigationPath([NoteRoute(id: id)]) }
                }
                .task { await model.loadIfNeeded() }
                .onChange(of: path) { _, path in LaunchSnapshot.shared.setPath("notes", path) }
                .onAppear { Task { await model.refresh() } }
                .writeFailureAlert(model)
        }
    }
}

extension View {
    /// A failed write is an alert over a screen that still holds the vault,
    /// not a replacement for it: the outline is still true, only the write
    /// did not happen. Attached to every screen in the stack that writes,
    /// because an alert on a covered screen does not present.
    func writeFailureAlert(_ model: VaultBrowseViewModel) -> some View {
        alert(
            model.writeFailure?.title ?? "",
            isPresented: Binding(
                get: { model.writeFailure != nil },
                set: { if !$0 { model.writeFailure = nil } }
            )
        ) {
            Button("OK", role: .cancel) { model.writeFailure = nil }
        } message: {
            // What to do next, when there is something to do. A failure with
            // no guidance says only what happened rather than inventing a
            // step that does not exist.
            if let guidance = model.writeFailure?.guidance {
                Text(guidance)
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
            Section("Folders stay A \u{2192} Z under every time mode.") {
                Picker("Sort notes", selection: $sort) {
                    ForEach(BrowseSort.allCases) { option in
                        Text(option.label).tag(option)
                    }
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
    @Binding var selectedFolder: String?
    let sort: BrowseSort
    let openFolder: (String) -> Void
    let openNote: (String) -> Void

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
                    selectedFolder: $selectedFolder,
                    sort: sort,
                    model: model,
                    openFolder: openFolder,
                    openNote: openNote
                )
            }
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
    }
}

/// The hierarchy itself, as one flat platform list.
private struct VaultOutlineList: View {
    let outline: VaultOutline
    @Binding var expanded: Set<String>
    @Binding var selectedFolder: String?
    let sort: BrowseSort
    /// Carried down for the row actions. The rows are where a rename, a move
    /// or a delete starts, and each one needs the writer behind them.
    let model: VaultBrowseViewModel
    let openFolder: (String) -> Void
    let openNote: (String) -> Void

    var body: some View {
        List {
            ForEach(outline.browseRows(expanded: expanded, sort: sort)) { row in
                BrowseRowView(
                    row: row,
                    toggle: toggle,
                    model: model,
                    selectedFolder: selectedFolder,
                    openFolder: openFolder,
                    openNote: openNote,
                    setExpanded: setExpanded
                )
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
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .restoresScroll("notes.root")
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .calmAnimation(.fast, value: expanded)
    }

    private func toggle(_ path: String) {
        if expanded.contains(path) { expanded.remove(path) } else { expanded.insert(path) }
        selectedFolder = path
    }

    private func setExpanded(_ paths: [String], _ isOpen: Bool) {
        if isOpen { expanded.formUnion(paths) } else { expanded.subtract(paths) }
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
