import Foundation
import MemryCore
import Observation
import SwiftUI

// #4346. The one owner of what Notes shows at regular width: the list
// column's scope, the selected note, and the notes opened from inside it.
//
// The sidebar and the list write through it, the detail column reads it, and
// every open from outside Notes (search, a capture's "View", a link) lands
// here through `NotesLinks`. Followers (the inspector, drag and drop, the
// two-note split, Handoff) read the selection from here, never from a column.
//
// At compact width the phone's stack stays the owner of navigation. It still
// reports each note it shows, so the last opened note survives a switch to
// regular width and a relaunch there (`DESIGN.md` › Tablet, D6).

/// What the list column shows.
enum NotesScope: Hashable, Codable, Sendable {
    /// The vault root: its folders and the notes outside every folder.
    case root
    case folder(String)
    case tag(String)
    case tags
    case bookmarks
}

/// A value a Notes link carries, and where it goes in the split view.
protocol NotesSplitRoute: Hashable {
    @MainActor func open(in router: NotesSplitRouter)
}

@MainActor
@Observable
final class NotesSplitRouter {
    /// What is saved across launches. Ids only, like every `LaunchSnapshot`
    /// entry. Each field is optional on decode so a later field never makes an
    /// older save unreadable.
    struct Saved: Codable, Equatable {
        var scope: NotesScope?
        var note: NoteRoute?
        var trail: [NoteRoute]?
    }

    static let snapshotKey = "notes.split"

    var scope: NotesScope = .root {
        didSet { save() }
    }

    /// The detail column's note, and the list's selected row.
    private(set) var note: NoteRoute? {
        didSet { save() }
    }

    /// Notes opened from inside the selected one (wiki links, backlinks,
    /// embeds). The detail column's stack: Back returns to the note before.
    var trail: [NoteRoute] = [] {
        didSet { save() }
    }

    private let snapshot: LaunchSnapshot?

    init(snapshot: LaunchSnapshot? = nil) {
        self.snapshot = snapshot
        guard let saved = snapshot?.stack(Self.snapshotKey, as: Saved.self) else { return }
        scope = saved.scope ?? .root
        note = saved.note
        trail = saved.trail ?? []
    }

    static func restored() -> NotesSplitRouter { NotesSplitRouter(snapshot: .shared) }

    /// The note on screen: the last one followed, else the selected one.
    var current: NoteRoute? { trail.last ?? note }

    /// A row picked in the list or the sidebar.
    func select(_ route: NoteRoute?) {
        note = route
        trail = []
    }

    /// A link followed inside the open note.
    func follow(_ route: NoteRoute) {
        trail.append(route)
    }

    func show(_ scope: NotesScope) {
        self.scope = scope
    }

    /// An open from outside Notes: the note in the detail column, its folder
    /// in the list so the row shows selected. `folder` is `nil` for a note
    /// this device does not list yet, which keeps the list where it is.
    func reveal(_ id: String, in outline: VaultOutline?) {
        if let outline, let listed = outline.allNotes.first(where: { $0.id == id }) {
            let folder = listed.folderPath.flatMap { outline.node(at: $0) == nil ? nil : $0 }
            scope = folder.map(NotesScope.folder) ?? .root
        }
        select(NoteRoute(id: id))
    }

    /// The compact stack showed a note: it is the one to come back to.
    func shown(_ route: NoteRoute) {
        guard current != route else { return }
        select(route)
    }

    /// Drops notes this vault no longer lists, such as one deleted from its
    /// own page, so the detail column falls back to its empty state rather
    /// than drawing a note that is gone.
    func prune(keeping ids: Set<String>) {
        if let note, !ids.contains(note.id) { select(nil) }
        let kept = trail.filter { ids.contains($0.id) }
        if kept != trail { trail = kept }
    }

    /// The phone stack that shows the same place, for a window that narrows
    /// to compact width (#4344).
    func compactPath() -> NavigationPath {
        var path = NavigationPath()
        switch scope {
        case .root: break
        case let .folder(folder): path.append(FolderRoute(path: folder))
        case let .tag(name): path.append(TagRoute(name: name))
        case .tags: path.append(TagListRoute())
        case .bookmarks: path.append(BookmarkListRoute())
        }
        for route in (note.map { [$0] } ?? []) + trail { path.append(route) }
        return path
    }

    private func save() {
        snapshot?.setStack(Self.snapshotKey, value: Saved(scope: scope, note: note, trail: trail))
    }
}

extension NoteRoute: NotesSplitRoute {
    func open(in router: NotesSplitRouter) { router.select(self) }
}

extension FolderRoute: NotesSplitRoute {
    func open(in router: NotesSplitRouter) { router.show(.folder(path)) }
}

extension TagRoute: NotesSplitRoute {
    func open(in router: NotesSplitRouter) { router.show(.tag(name)) }
}

extension TagListRoute: NotesSplitRoute {
    func open(in router: NotesSplitRouter) { router.show(.tags) }
}

extension BookmarkListRoute: NotesSplitRoute {
    func open(in router: NotesSplitRouter) { router.show(.bookmarks) }
}

/// A link in a Notes list. At compact width it is the stack's value link, as
/// before. Inside the split view it routes through ``NotesSplitRouter``, so a
/// bookmark or a tag fills the list column and a note fills the detail column
/// instead of pushing over the column it was tapped in.
struct NotesLink<Value: NotesSplitRoute, Label: View>: View {
    let value: Value
    @ViewBuilder let label: () -> Label
    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?

    var body: some View {
        if let split {
            Button { value.open(in: split) } label: { label() }
                .buttonStyle(.plain)
        } else {
            NavigationLink(value: value) { label() }
        }
    }
}

/// A list of notes that, inside the split view, selects the note a row links
/// to instead of pushing it. Rows keep their `NavigationLink(value:)`: a value
/// link in a list whose selection has the link's type sets the selection.
/// There ↑ ↓ select the next note, which shows it in the detail column, as a
/// row's tap does (#4355).
struct NotesList<Content: View>: View {
    /// The note rows' ids, in the order the list draws them.
    let noteIds: [String]
    @ViewBuilder let content: () -> Content
    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?

    var body: some View {
        if let split {
            List(selection: Binding(get: { split.note }, set: { split.select($0) })) { content() }
                .background {
                    ListKeys(ids: noteIds, current: split.note?.id, move: open, open: open)
                }
        } else {
            List { content() }
        }
    }
}

extension NotesList {
    private func open(_ id: String) { split?.select(NoteRoute(id: id)) }
}

extension View {
    /// Marks the split view's selected note row with desktop's active-row
    /// fill. `BrowseRowView` sets its own `listRowBackground`, which hides the
    /// list's selection highlight and outranks one set here, so the fill sits
    /// behind the row's content. A no-op at compact width and on folders.
    func notesSelection(_ row: BrowseRow) -> some View {
        modifier(NotesRowSelection(row: row))
    }
}

private struct NotesRowSelection: ViewModifier {
    let row: BrowseRow
    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?

    func body(content: Content) -> some View {
        if let split, case let .note(note) = row.kind {
            content.background {
                if split.note?.id == note.id {
                    RoundedRectangle(cornerRadius: Tokens.Radius.small)
                        .fill(Tokens.Canvas.surfaceActive.color)
                }
            }
        } else {
            content
        }
    }
}
