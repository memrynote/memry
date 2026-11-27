import Foundation
import MemryCore
import SwiftUI
import Testing

@testable import Memry

// #4377: the Notes detail column holds a second note beside the first. The
// router owns both panes, which one has the focus, and their save.

private func snapshot() -> LaunchSnapshot {
    let snapshot = LaunchSnapshot(defaults: UserDefaults(suiteName: "notes-two-pane-\(UUID().uuidString)")!)
    snapshot.vaultOpened(VaultSummary(id: "vault", name: nil))
    return snapshot
}

private let plan = NoteRoute(id: "plan")
private let loose = NoteRoute(id: "loose")
private let draft = NoteRoute(id: "draft")

/// The save a build without the split writes and reads.
private struct OldSaved: Codable, Equatable {
    var scope: NotesScope?
    var note: NoteRoute?
    var trail: [NoteRoute]?
}

@MainActor
@Suite("#4377 two notes side by side")
struct NotesTwoPaneTests {
    private func split(_ snapshot: LaunchSnapshot? = nil) -> NotesSplitRouter {
        let router = NotesSplitRouter(snapshot: snapshot)
        router.splitFits = true
        router.select(plan)
        return router
    }

    @Test("Open to the Side opens a second pane, which takes the focus")
    func openToTheSide() {
        let router = split()
        router.openToTheSide(loose)

        #expect(router.pane(.main) == NotesPane(note: plan))
        #expect(router.pane(.side) == NotesPane(note: loose))
        #expect(router.focus == .side)
        #expect(router.splitShown)
        #expect(router.selected == loose, "the list marks the focused pane's note")
    }

    @Test("from the side pane, Open to the Side replaces the main pane")
    func openToTheSideFromTheSide() {
        let router = split()
        router.openToTheSide(loose)
        router.openToTheSide(draft, from: .side)

        #expect(router.pane(.main) == NotesPane(note: draft))
        #expect(router.pane(.side) == NotesPane(note: loose))
        #expect(router.focus == .main)
    }

    @Test("the list, a link and a touch act on the focused pane")
    func theFocusedPaneTakesOpens() {
        let router = split()
        router.openToTheSide(loose)
        router.select(draft)
        #expect(router.pane(.side) == NotesPane(note: draft))
        #expect(router.pane(.main) == NotesPane(note: plan))

        router.activate(.main)
        router.follow(loose)
        #expect(router.pane(.main) == NotesPane(note: plan, trail: [loose]))
        #expect(router.current == loose)
        #expect(router.focus == .main)
    }

    @Test("⌘\\ opens the focused note's last followed link beside it")
    func splitRightOpensTheLastLink() {
        let router = split()
        router.follow(loose)
        router.setTrail([], in: .main)
        router.splitRight()

        #expect(router.pane(.side) == NotesPane(note: loose))
        #expect(router.focus == .side)
    }

    @Test("⌘\\ with no link followed from the note opens an empty pane, once")
    func splitRightWithoutALink() {
        let router = split()
        router.splitRight()
        #expect(router.pane(.side) == NotesPane())
        router.select(draft)
        router.splitRight()
        #expect(router.pane(.side) == NotesPane(note: draft), "a second ⌘\\ keeps the open pane")
    }

    @Test("⌘⌥W closes the focused pane and the other fills the column")
    func closeSplitClosesTheFocusedPane() {
        let router = split()
        router.openToTheSide(loose)
        router.closeSplit()
        #expect(router.side == nil)
        #expect(router.pane(.main) == NotesPane(note: plan))

        router.openToTheSide(loose)
        router.activate(.main)
        router.closeSplit()
        #expect(router.side == nil)
        #expect(router.pane(.main) == NotesPane(note: loose))
        #expect(router.focus == .main)
    }

    @Test("while both panes show, each pane draws its own header, focused or not")
    func eachPaneHasItsOwnHeader() {
        let router = split()
        let main = NotesPaneContext(router: router, slot: .main)
        let side = NotesPaneContext(router: router, slot: .side)
        #expect(!main.headed, "one pane: the navigation bar carries its controls")

        router.openToTheSide(loose)
        #expect(main.headed && side.headed)
        router.activate(.main)
        #expect(main.headed && side.headed)

        router.splitFits = false
        #expect(!main.headed, "the pane shown alone goes back to the navigation bar")
    }

    @Test("a width too narrow for two panes shows the focused one and keeps the other")
    func collapseAndRestore() {
        let router = split()
        router.openToTheSide(loose)
        router.activate(.main)

        router.splitFits = false
        #expect(!router.splitShown)
        #expect(router.shows(.main) && !router.shows(.side))
        #expect(router.pane(.side) == NotesPane(note: loose))

        router.activate(.side)
        #expect(!router.shows(.main) && router.shows(.side))

        router.splitFits = true
        #expect(router.shows(.main) && router.shows(.side))
    }

    @Test("a note deleted from the side pane leaves it empty")
    func pruneEmptiesTheSidePane() {
        let router = split()
        router.openToTheSide(loose)
        router.prune(keeping: ["plan"])
        #expect(router.pane(.side) == NotesPane())
        #expect(router.pane(.main) == NotesPane(note: plan))
    }

    // MARK: The save

    @Test("both panes, the focus and the ratio come back after a relaunch")
    func splitRoundTrips() {
        let saved = snapshot()
        let router = split(saved)
        router.openToTheSide(loose)
        router.follow(draft, in: .side)
        router.ratio = 0.62
        router.activate(.main)

        let relaunched = NotesSplitRouter(snapshot: saved)
        #expect(relaunched.pane(.main) == NotesPane(note: plan))
        #expect(relaunched.pane(.side) == NotesPane(note: loose, trail: [draft]))
        #expect(relaunched.focus == .main)
        #expect(relaunched.ratio == 0.62)
    }

    @Test("a save from before the split opens one pane")
    func anOldSaveDecodes() throws {
        let saved = snapshot()
        let old = OldSaved(scope: .folder("Projects"), note: plan, trail: [loose])
        saved.setStack(NotesSplitRouter.snapshotKey, try JSONEncoder().encode(old))

        let router = NotesSplitRouter(snapshot: saved)
        #expect(router.scope == .folder("Projects"))
        #expect(router.pane(.main) == NotesPane(note: plan, trail: [loose]))
        #expect(router.side == nil)
        #expect(router.focus == .main)
        #expect(router.ratio == 0.5)
    }

    @Test("a build without the split reads a split save as its main pane")
    func anOldBuildReadsASplitSave() throws {
        let saved = snapshot()
        let router = split(saved)
        router.show(.tags)
        router.openToTheSide(loose)

        let read = try #require(saved.stack(NotesSplitRouter.snapshotKey, as: OldSaved.self))
        #expect(read == OldSaved(scope: .tags, note: plan, trail: []))
    }

    @Test("a focus a later build names reads as the main pane")
    func anUnknownFocusIsTheMainPane() {
        let saved = snapshot()
        saved.setStack(NotesSplitRouter.snapshotKey, Data(#"""
        {"note":{"id":"plan"},"side":{"note":{"id":"loose"}},"focus":"third","ratio":0.4}
        """#.utf8))

        let router = NotesSplitRouter(snapshot: saved)
        #expect(router.focus == .main)
        #expect(router.pane(.side) == NotesPane(note: loose))
        #expect(router.ratio == 0.4)
    }

    // MARK: The menu bar

    private func commands(_ router: NotesSplitRouter) -> VaultCommands {
        let tasks = TasksRouter()
        tasks.selectedTab = .notes
        var commands = VaultCommands(
            tasks: tasks,
            journal: JournalRouter(),
            pages: VaultTabLayout(savedOrder: [], width: .regular) { _ in true }.commandPages,
            newNote: nil,
            quickCapture: nil,
            search: {},
            sideRails: SideRails(defaults: UserDefaults(suiteName: "two-pane-\(UUID())") ?? .standard),
            commandPalette: { _ in }
        )
        commands.notesSplit = router
        return commands
    }

    @Test("⌘\\ and ⌘⌥W run on Notes while the width holds two panes")
    func splitCommandsRun() {
        let router = split()
        let commands = commands(router)
        #expect(commands.can(.splitRight) && !commands.can(.closeSplit))

        commands.run(.splitRight)
        #expect(router.side != nil)
        #expect(!commands.can(.splitRight) && commands.can(.closeSplit))

        commands.run(.closeSplit)
        #expect(router.side == nil)
    }

    @Test("⌘\\ and ⌘⌥W are off while the split is collapsed")
    func splitCommandsOffWhileCollapsed() {
        let router = split()
        router.openToTheSide(loose)
        router.splitFits = false
        let commands = commands(router)
        #expect(!commands.can(.splitRight) && !commands.can(.closeSplit))

        commands.run(.closeSplit)
        #expect(router.side != nil, "the hidden pane is kept, not closed")
    }
}
