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
//
// **Two panes (#4377).** The detail column can hold a second note beside the
// first, as desktop's `⌘\` split does. Each pane has its own back stack. The
// focused pane, the one last touched or opened, takes what the list, search
// and the menu bar open, and the list marks its note. The side pane is kept
// while the width cannot show it, so it comes back when the width does.

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
    ///
    /// `note` and `trail` are the main pane, as before the split. The split's
    /// keys are additive: a build without the split ignores them and opens
    /// the main pane, and `focus` is a raw string, so a slot a later build
    /// adds reads as the main pane rather than failing the whole save.
    struct Saved: Codable, Equatable {
        var scope: NotesScope?
        var note: NoteRoute?
        var trail: [NoteRoute]?
        var side: NotesPane?
        var focus: String?
        var ratio: Double?
    }

    static let snapshotKey = "notes.split"
    /// The phone stack's save (`NotesListView`).
    static let compactKey = "notes"

    /// Set while the split view shows this router. The phone stack saves its
    /// own path, but at regular width nothing else saves it, and a switch to
    /// compact width can build a new Notes page that restores from that save
    /// (#4503). The router then saves the stack that shows its place.
    var isSplit = false

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

    /// The second pane, `nil` while the detail column holds one note. Kept
    /// while the width collapses the split.
    private(set) var side: NotesPane? {
        didSet { save() }
    }

    /// The pane the list, search and the menu bar act on.
    private(set) var focus: NotesPaneSlot = .main {
        didSet { if focus != oldValue { save() } }
    }

    /// The main pane's share of the detail column's width.
    var ratio = 0.5 {
        didSet { save() }
    }

    /// Set by the split view: its width holds two panes.
    var splitFits = false

    /// The last link each pane followed, and the note it was followed from:
    /// what `⌘\` opens beside that note. Not saved.
    @ObservationIgnored private var lastLinks: [NotesPaneSlot: (from: NoteRoute, to: NoteRoute)] = [:]

    private let snapshot: LaunchSnapshot?

    init(snapshot: LaunchSnapshot? = nil) {
        self.snapshot = snapshot
        guard let saved = snapshot?.stack(Self.snapshotKey, as: Saved.self) else { return }
        scope = saved.scope ?? .root
        note = saved.note
        trail = saved.trail ?? []
        side = saved.side
        focus = side == nil ? .main : saved.focus.flatMap(NotesPaneSlot.init(rawValue:)) ?? .main
        ratio = saved.ratio ?? 0.5
    }

    static func restored() -> NotesSplitRouter { NotesSplitRouter(snapshot: .shared) }

    /// The focused pane's note on screen: the last one followed, else the
    /// one it opened on.
    var current: NoteRoute? { pane(focus)?.current }

    /// The focused pane's own note, which the list marks.
    var selected: NoteRoute? { pane(focus)?.note }

    /// Both panes are on screen.
    var splitShown: Bool { side != nil && splitFits }

    func pane(_ slot: NotesPaneSlot) -> NotesPane? {
        switch slot {
        case .main: NotesPane(note: note, trail: trail)
        case .side: side
        }
    }

    /// A row picked in the list or the sidebar, into the focused pane.
    func select(_ route: NoteRoute?) {
        update(focus) { $0 = NotesPane(note: route) }
    }

    /// `route` as `slot`'s own note, which takes the focus.
    func open(_ route: NoteRoute, in slot: NotesPaneSlot) {
        update(slot) { $0 = NotesPane(note: route) }
        activate(slot)
    }

    /// A link followed inside a pane, by default the focused one.
    func follow(_ route: NoteRoute, in slot: NotesPaneSlot? = nil) {
        let slot = slot ?? focus
        update(slot) { pane in
            if let from = pane.current { lastLinks[slot] = (from, route) }
            pane.trail.append(route)
        }
        focus = slot
    }

    /// A pane's back stack, as its `NavigationStack` changes it.
    func setTrail(_ trail: [NoteRoute], in slot: NotesPaneSlot) {
        update(slot) { if $0.trail != trail { $0.trail = trail } }
    }

    /// A touch in a pane.
    func activate(_ slot: NotesPaneSlot) {
        guard pane(slot) != nil else { return }
        focus = slot
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
        for slot in NotesPaneSlot.allCases {
            update(slot) { pane in
                if let note = pane.note, !ids.contains(note.id) { pane = NotesPane() }
                let kept = pane.trail.filter { ids.contains($0.id) }
                if kept != pane.trail { pane.trail = kept }
            }
        }
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
        let pane = pane(focus) ?? NotesPane(note: note, trail: trail)
        for route in (pane.note.map { [$0] } ?? []) + pane.trail { path.append(route) }
        return path
    }

    private func update(_ slot: NotesPaneSlot, _ change: (inout NotesPane) -> Void) {
        switch slot {
        case .main:
            var pane = NotesPane(note: note, trail: trail)
            change(&pane)
            if pane.note != note { note = pane.note }
            if pane.trail != trail { trail = pane.trail }
        case .side:
            guard var pane = side else { return }
            change(&pane)
            if pane != side { side = pane }
        }
    }

    private func save() {
        snapshot?.setStack(Self.snapshotKey, value: Saved(
            scope: scope, note: note, trail: trail,
            side: side, focus: side == nil ? nil : focus.rawValue, ratio: side == nil ? nil : ratio
        ))
        if isSplit { snapshot?.setPath(Self.compactKey, compactPath()) }
    }
}

// MARK: - The split (#4377)

extension NotesSplitRouter {
    /// `⌘\` (desktop's `tabs.splitRight`): a side pane beside the focused
    /// one, on the note the focused note's last followed link opened, or
    /// empty with a note picker when it followed none.
    func splitRight() {
        guard side == nil else { return }
        let target = pane(focus)?.current.flatMap { current in
            lastLinks[focus].flatMap { $0.from == current ? $0.to : nil }
        }
        side = NotesPane(note: target)
        focus = .side
    }

    /// "Open to the Side" and `⌘`-click: `route` in the pane beside `slot`,
    /// which takes the focus. With one pane, that is a new side pane.
    func openToTheSide(_ route: NoteRoute, from slot: NotesPaneSlot? = nil) {
        let target: NotesPaneSlot = (slot ?? focus) == .side ? .main : .side
        if target == .side, side == nil {
            side = NotesPane(note: route)
        } else {
            update(target) { $0 = NotesPane(note: route) }
        }
        focus = target
    }

    /// `⌘⌥W` (desktop's `tabs.closeSplit`): closes the focused pane, and the
    /// other one fills the detail column.
    func closeSplit() {
        guard let side else { return }
        if focus == .main { update(.main) { $0 = side } }
        lastLinks = [:]
        focus = .main
        self.side = nil
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
struct NotesList<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?

    var body: some View {
        if let split {
            List(selection: Binding(get: { split.selected }, set: { split.select($0) })) { content() }
        } else {
            List { content() }
        }
    }
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
                if split.selected?.id == note.id {
                    RoundedRectangle(cornerRadius: Tokens.Radius.small)
                        .fill(Tokens.Canvas.surfaceActive.color)
                }
            }
        } else {
            content
        }
    }
}
