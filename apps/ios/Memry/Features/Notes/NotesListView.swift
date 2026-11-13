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
    @State private var path = LaunchSnapshot.shared.path(NotesSplitRouter.compactKey)
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
    /// What the split view shows at regular width. The phone stack reports
    /// the notes it shows to it, so the last one survives a switch of width.
    @State private var router = NotesSplitRouter.restored()
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private let notesLinks = NotesLinks.shared
    @Environment(\.requestVaultSync) private var requestVaultSync

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

    /// The shell's own rule: a sidebar needs regular width and height.
    private var width: LayoutWidth {
        LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    var body: some View {
        Group {
            if width == .regular {
                NotesSplitView(model: model, router: router, sort: $sort)
            } else {
                NavigationStack(path: $path) {
                    VaultBrowseScreen(
                        model: model,
                        expanded: $expanded,
                        selectedFolder: $selectedFolder,
                        sort: sort,
                        openFolder: { path.append(FolderRoute(path: $0)) },
                        openNote: { path.append(NoteRoute(id: $0)) },
                        openTag: { path.append(TagRoute(name: $0)) }
                    )
                        .navigationDestination(for: FolderRoute.self) { route in
                            FolderScreen(
                                route: route,
                                model: model,
                                openFolder: { path.append(FolderRoute(path: $0)) },
                                openNote: { path.append(NoteRoute(id: $0)) }
                            )
                            .onAppear { router.show(.folder(route.path)) }
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
                            .onAppear { router.shown(route) }
                        }
                        // N600, registered on the root for the same reason the two
                        // above are: a `#tag` tapped deep in a note, and a restored
                        // path pointing at a tag, both resolve here.
                        .navigationDestination(for: TagRoute.self) { route in
                            TaggedNotesView(tag: route.name, browse: model, open: { path.append($0) })
                        }
                        .navigationDestination(for: TagListRoute.self) { _ in
                            TagListView(browse: model)
                        }
                        .navigationDestination(for: BookmarkListRoute.self) { _ in
                            BookmarkListView(browse: model)
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
                        // The page's "+": tap for a note, hold for a folder. Shown
                        // only where a write can actually happen, and only on the
                        // root: a folder's screen carries its own.
                        .notesCreate(model, in: nil, place: "At the top of this vault.") {
                            path.append(NoteRoute(id: $0))
                        }
                        // A search hit or a capture's "View" opens its note here.
                        .onChange(of: notesLinks.pending, initial: true) {
                            if let id = notesLinks.take() { path = NavigationPath([NoteRoute(id: id)]) }
                        }
                        .task { await model.loadIfNeeded() }
                        // Not a one-off in `.task`: Notes is the first tab, and on a
                        // cold launch the vault's sync request is still nil until the
                        // tasks store exists.
                        .onChange(of: requestVaultSync == nil, initial: true) {
                            model.requestSync = requestVaultSync
                        }
                        .onChange(of: path) { _, path in LaunchSnapshot.shared.setPath(NotesSplitRouter.compactKey, path) }
                        .onAppear { Task { await model.refresh() } }
                        .writeFailureAlert(model)
                }
            }
        }
        // A window that narrows to compact width keeps its place (#4344).
        .onChange(of: width) { _, width in
            if width == .compact { path = router.compactPath() }
        }
        .onChange(of: width, initial: true) { _, width in router.isSplit = width == .regular }
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
