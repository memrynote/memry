import Foundation
import MemryCore
import SwiftUI
import Testing

@testable import Memry

// #4346: what the Notes split view shows lives in one router, and it comes
// back after a relaunch and across a compact ↔ regular switch.

private func snapshot() -> LaunchSnapshot {
    let snapshot = LaunchSnapshot(defaults: UserDefaults(suiteName: "notes-split-\(UUID().uuidString)")!)
    snapshot.vaultOpened("vault")
    return snapshot
}

private func note(_ id: String, in folder: String?) -> NoteSummary {
    NoteSummary(id: id, title: id, folderPath: folder, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: [])
}

private let outline = VaultOutline.build(
    folders: [FolderSummary(path: "Projects", parentPath: nil, name: "Projects", icon: nil)],
    notes: [note("plan", in: "Projects"), note("loose", in: nil)]
)

@MainActor
@Suite("#4346 notes split router")
struct NotesSplitRouterTests {
    @Test("the folder, the note and the notes followed from it come back after a relaunch")
    func relaunchRestores() {
        let saved = snapshot()
        let router = NotesSplitRouter(snapshot: saved)
        router.show(.folder("Projects"))
        router.select(NoteRoute(id: "plan"))
        router.follow(NoteRoute(id: "loose"))

        let relaunched = NotesSplitRouter(snapshot: saved)
        #expect(relaunched.scope == .folder("Projects"))
        #expect(relaunched.note == NoteRoute(id: "plan"))
        #expect(relaunched.trail == [NoteRoute(id: "loose")])
    }

    @Test("a save without the trail, or with nothing at all, still restores")
    func partialSaveRestores() throws {
        let saved = snapshot()
        saved.setStack(NotesSplitRouter.snapshotKey, Data(#"{"note":{"id":"plan"}}"#.utf8))
        let router = NotesSplitRouter(snapshot: saved)
        #expect(router.scope == .root)
        #expect(router.note == NoteRoute(id: "plan"))
        #expect(router.trail.isEmpty)
    }

    @Test("picking a row replaces the notes followed from the last one")
    func selectClearsTheTrail() {
        let router = NotesSplitRouter()
        router.select(NoteRoute(id: "plan"))
        router.follow(NoteRoute(id: "loose"))
        #expect(router.current == NoteRoute(id: "loose"))
        router.select(NoteRoute(id: "loose"))
        #expect(router.trail.isEmpty)
        #expect(router.current == NoteRoute(id: "loose"))
    }

    @Test("an open from search shows the note and moves the list to its folder")
    func revealSelectsTheRow() {
        let router = NotesSplitRouter()
        router.show(.tag("work"))
        router.reveal("plan", in: outline)
        #expect(router.scope == .folder("Projects"))
        #expect(router.note == NoteRoute(id: "plan"))

        router.reveal("loose", in: outline)
        #expect(router.scope == .root)
    }

    @Test("a note this device does not list yet opens without moving the list")
    func revealUnlistedKeepsTheList() {
        let router = NotesSplitRouter()
        router.show(.folder("Projects"))
        router.reveal("elsewhere", in: outline)
        #expect(router.scope == .folder("Projects"))
        #expect(router.note == NoteRoute(id: "elsewhere"))
    }

    @Test("a deleted note leaves the detail column for its empty state")
    func pruneDropsGoneNotes() {
        let router = NotesSplitRouter()
        router.select(NoteRoute(id: "plan"))
        router.follow(NoteRoute(id: "gone"))
        router.prune(keeping: ["plan"])
        #expect(router.note == NoteRoute(id: "plan"))
        #expect(router.trail.isEmpty)
        router.prune(keeping: [])
        #expect(router.note == nil)
    }

    @Test("the compact stack shows the note last opened on the split view")
    func compactPathCarriesThePlace() throws {
        let router = NotesSplitRouter()
        router.show(.folder("Projects"))
        router.select(NoteRoute(id: "plan"))
        router.follow(NoteRoute(id: "loose"))
        let path = router.compactPath()
        #expect(path.count == 3)
        let saved = try JSONEncoder().encode(#require(path.codable))
        let text = String(decoding: saved, as: UTF8.self)
        #expect(text.contains("Projects"))
        #expect(text.contains("plan") && text.contains("loose"))
    }

    /// #4503: a switch to compact width can build a new Notes page, which
    /// restores its stack from the save. A note the split view opened, here
    /// by the list's "+" (`NotesSplitView.open`), is on that stack.
    @Test("a note created in the split view is on the stack a new compact page restores")
    func splitWritesTheCompactSave() throws {
        let snapshot = snapshot()
        let router = NotesSplitRouter(snapshot: snapshot)
        router.isSplit = true
        router.show(.folder("Projects"))
        router.select(NoteRoute(id: "created"))
        let restored = snapshot.path(NotesSplitRouter.compactKey)
        #expect(restored.count == 2)
        let saved = try JSONEncoder().encode(#require(restored.codable))
        let text = String(decoding: saved, as: UTF8.self)
        #expect(text.contains("Projects") && text.contains("created"))
    }

    /// At compact width the phone stack owns its save, which can be deeper
    /// than the router's place (a folder inside a folder).
    @Test("the phone stack's save is its own at compact width")
    func compactKeepsItsSave() {
        let snapshot = snapshot()
        let router = NotesSplitRouter(snapshot: snapshot)
        router.shown(NoteRoute(id: "plan"))
        #expect(snapshot.stack(NotesSplitRouter.compactKey) == nil)
    }

    @Test("a note the phone stack shows becomes the one regular width opens")
    func compactReportsTheNote() {
        let router = NotesSplitRouter()
        router.shown(NoteRoute(id: "plan"))
        #expect(router.note == NoteRoute(id: "plan"))
    }
}
