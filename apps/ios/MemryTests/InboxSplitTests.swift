import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

// #4349: which item the Inbox's detail column shows after its list changes.

struct InboxDetailSelectionTests {
    private func picked(_ id: String) -> InboxDetailSelection { InboxDetailSelection(id: id, explicit: true) }
    private func auto(_ id: String) -> InboxDetailSelection { InboxDetailSelection(id: id, explicit: false) }

    @Test func anItemThatLeavesHandsTheSelectionToTheNextOne() {
        #expect(InboxDetailSelection.next(after: picked("b"), old: ["a", "b", "c"], new: ["a", "c"]) == auto("c"))
    }

    @Test func theLastItemHandsTheSelectionToTheOneBefore() {
        #expect(InboxDetailSelection.next(after: picked("c"), old: ["a", "b", "c"], new: ["a", "b"]) == auto("b"))
    }

    @Test func theNextItemThatLeftTooIsSkipped() {
        #expect(InboxDetailSelection.next(after: picked("b"), old: ["a", "b", "c", "d"], new: ["a", "d"]) == auto("d"))
    }

    @Test func anEmptiedListLeavesNoSelection() {
        #expect(InboxDetailSelection.next(after: picked("a"), old: ["a"], new: []) == nil)
    }

    @Test func noSelectionTakesTheFirstItem() {
        #expect(InboxDetailSelection.next(after: nil, old: [], new: ["a", "b"]) == auto("a"))
    }

    @Test func anItemStillListedStaysSelectedAsTheUserPickedIt() {
        #expect(InboxDetailSelection.next(after: picked("b"), old: ["a", "b"], new: ["x", "a", "b"]) == picked("b"))
    }

    @Test func anItemTheListNeverHeldFallsToTheFirst() {
        #expect(InboxDetailSelection.next(after: picked("z"), old: ["a", "b"], new: ["b"]) == auto("b"))
    }

    /// The split view remounts after a width change with `old == new`.
    @Test func aRemountDropsAnItemTheListDoesNotHold() {
        #expect(InboxDetailSelection.next(after: picked("z"), old: ["a", "b"], new: ["a", "b"]) == auto("a"))
    }

    @Test func aListSwitchWithNoNeighborLeftTakesTheNewFirstItem() {
        #expect(InboxDetailSelection.next(after: picked("b"), old: ["a", "b"], new: ["x", "y"]) == auto("x"))
    }
}

@MainActor
struct InboxRouterSplitTests {
    @Test func atRegularWidthAnOpenSelectsInsteadOfPushing() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.path = [.inboxSettings]
        router.open("a")
        #expect(router.selection == InboxDetailSelection(id: "a", explicit: true))
        #expect(router.path.isEmpty)
    }

    @Test func atCompactWidthAnOpenPushes() {
        let router = InboxRouter()
        router.open("a")
        #expect(router.path == [.item("a")])
        #expect(router.selection == nil)
    }

    @Test func aPushedItemBecomesTheSelectionAtRegularWidthAndBack() {
        let router = InboxRouter()
        router.open("a")
        router.adapt(to: .regular)
        #expect(router.selection == InboxDetailSelection(id: "a", explicit: true))
        #expect(router.path.isEmpty)
        router.adapt(to: .compact)
        #expect(router.path == [.item("a")])
        #expect(router.selection == nil)
    }

    /// Calendar's "Open in Inbox" names a snoozed capture the Inbox list
    /// does not hold: the list waits for the detail column to switch lists.
    @Test func anItemOpenedFromOutsideStaysUntilItsListShows() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.follow(["a"], ["a"])
        #expect(router.revealing == "z")
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
        router.revealed(["y", "z"], exists: true)
        #expect(router.revealing == nil)
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
    }

    /// Calendar, search or a capture's "View" opened an item before the
    /// Inbox tab ever showed at regular width: the router was still compact.
    @Test func anItemOpenedBeforeTheFirstRegularLayoutIsRevealed() {
        let router = InboxRouter()
        router.openItem("z", in: TasksRouter())
        router.adapt(to: .regular)
        #expect(router.revealing == "z")
        router.follow(["a"], ["a"])
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
    }

    /// #4534: the user taps row `a` while Calendar's snoozed `z` is still
    /// being revealed. The tap wins, and the list keeps following.
    @Test func aRowTappedDuringARevealEndsIt() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.open("a")
        #expect(router.revealing == nil)
        router.follow(["a", "b"], ["b"])
        #expect(router.selection == InboxDetailSelection(id: "b", explicit: false))
    }

    /// #4534: a notification opens the Inbox while a reveal is in flight:
    /// the list's first item, not the revealed one.
    @Test func aNotificationDuringARevealEndsIt() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.openInbox(in: TasksRouter())
        #expect(router.revealing == nil)
        router.follow(["a"], ["a"])
        #expect(router.selection == InboxDetailSelection(id: "a", explicit: false))
    }

    @Test func goingCompactEndsAReveal() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.adapt(to: .compact)
        #expect(router.revealing == nil)
        #expect(router.path == [.item("z")])
    }

    /// A filed capture opened from search: no list holds it, and it stays
    /// until a list does or the user opens another item.
    @Test func anOpenedItemNoListHoldsStaysSelected() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.revealed(["a"], exists: true)
        router.follow(["a"], ["a", "b"])
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
        router.follow(["a", "b"], ["z", "a", "b"])
        router.follow(["z", "a", "b"], ["a", "b"])
        #expect(router.selection == InboxDetailSelection(id: "a", explicit: false))
    }

    @Test func anOpenedItemGoneFromTheVaultFallsToTheFirst() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.revealed(["a"], exists: false)
        #expect(router.selection == InboxDetailSelection(id: "a", explicit: false))
    }

    /// F5: archiving (or snoozing, filing, deleting) a capture no list holds
    /// moves off it, as acting on a listed one does.
    @Test func archivingAnUnlistedItemFallsToTheFirst() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.revealed(["a", "b"], exists: true)
        #expect(router.unlisted == "z")
        router.left("z", order: ["a", "b"])
        #expect(router.unlisted == nil)
        #expect(router.selection == InboxDetailSelection(id: "a", explicit: false))
    }

    /// A listed item waits for its list to change, which hands the
    /// selection to the next item, not the first.
    @Test func archivingAListedItemLeavesTheHandOffToTheList() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.open("b")
        router.left("b", order: ["a", "b", "c"])
        #expect(router.selection == InboxDetailSelection(id: "b", explicit: true))
        router.follow(["a", "b", "c"], ["a", "c"])
        #expect(router.selection == InboxDetailSelection(id: "c", explicit: false))
    }

    /// F7: an unlisted item survives a trip through compact width.
    @Test func anUnlistedItemStaysSelectedAcrossCompactAndBack() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: TasksRouter())
        router.revealed(["a"], exists: true)
        router.adapt(to: .compact)
        #expect(router.path == [.item("z")])
        router.adapt(to: .regular)
        #expect(router.revealing == "z")
        router.revealed(["a"], exists: true)
        router.follow(["a"], ["a", "b"])
        #expect(router.unlisted == "z")
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
        #expect(router.path.isEmpty)
    }

    @Test func anItemTheAppSelectedIsNotPushedAtCompactWidth() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.follow([], ["a"])
        router.adapt(to: .compact)
        #expect(router.path.isEmpty)
    }
}

/// The detail column beside the list, over a real scratch vault.
@MainActor
@Suite("Inbox split detail", .serialized)
struct InboxSplitDetailTests {
    private struct Host: View {
        let store: InboxStore
        let router: InboxRouter
        var body: some View {
            InboxTab(store: store)
                .environment(router)
                .environment(TasksRouter())
                .environment(\.horizontalSizeClass, .regular)
                .environment(\.verticalSizeClass, .regular)
        }
    }

    /// The app selects the first item without marking it viewed; the user
    /// then opening that same item marks it (desktop counts a reminder in the
    /// badge until then).
    @Test func openingTheItemTheAppSelectedMarksItViewed() async throws {
        let scratch = try InboxTestVault()
        _ = await scratch.store.capture("[agent] remind me")
        let database = scratch.directory.appendingPathComponent(VaultFiles.dataDatabaseName).path
        try execute("""
            UPDATE sync_items SET payload = json_set(payload, '$.type', 'reminder') WHERE item_type = 'inbox';
            UPDATE inbox_items SET type = 'reminder';
            """, in: database)
        await scratch.store.refresh()
        let reminder = try #require(scratch.store.items.first)
        let router = InboxRouter()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1366, height: 1024))
        window.rootViewController = UIHostingController(rootView: Host(store: scratch.store, router: router))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        try await settle { router.selection != nil }
        #expect(router.selection == InboxDetailSelection(id: reminder.id, explicit: false))
        try await Task.sleep(for: .milliseconds(300))
        #expect(scratch.store.badgeCount == 1, "the app's own selection marked the reminder viewed")

        router.open(reminder.id)
        try await settle { scratch.store.badgeCount == 0 }
        #expect(scratch.store.items.first?.viewedAtMs != nil, "opening the selected reminder did not mark it viewed")
    }

    /// Calendar's "Open in Inbox" on a snoozed capture: the list switches to
    /// Snoozed, so the item stays selected beside its own row.
    @Test func openingASnoozedCaptureFromOutsideShowsTheSnoozedList() async throws {
        let scratch = try InboxTestVault()
        _ = await scratch.store.capture("[agent] stays in the inbox")
        _ = await scratch.store.capture("[agent] snoozed for later")
        let snoozed = try #require(scratch.store.items.first { $0.title.contains("snoozed") })
        await scratch.store.snooze([snoozed.id], until: Date().addingTimeInterval(3600))
        let router = InboxRouter()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1366, height: 1024))
        window.rootViewController = UIHostingController(rootView: Host(store: scratch.store, router: router))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await settle { router.selection != nil }

        router.openItem(snoozed.id, in: TasksRouter())
        try await settle { scratch.store.view == .snoozed && router.revealing == nil }
        #expect(scratch.store.view == .snoozed)
        #expect(router.selection == InboxDetailSelection(id: snoozed.id, explicit: true))
    }

    /// F1: Calendar opened a snoozed capture before the Inbox tab first
    /// laid out at regular width, so the router pushed it.
    @Test func anItemOpenedBeforeTheTabShowsStaysSelectedInItsList() async throws {
        let scratch = try InboxTestVault()
        _ = await scratch.store.capture("[agent] stays in the inbox")
        _ = await scratch.store.capture("[agent] snoozed for later")
        let snoozed = try #require(scratch.store.items.first { $0.title.contains("snoozed") })
        await scratch.store.snooze([snoozed.id], until: Date().addingTimeInterval(3600))
        let router = InboxRouter()
        router.openItem(snoozed.id, in: TasksRouter())
        let window = show(Host(store: scratch.store, router: router))
        defer { window.isHidden = true }

        try await settle { scratch.store.view == .snoozed && router.revealing == nil }
        #expect(scratch.store.view == .snoozed)
        #expect(router.selection == InboxDetailSelection(id: snoozed.id, explicit: true))
    }

    /// Search opens a filed capture (#4320), which no list holds: the detail
    /// shows it, as the pushed page does at compact width.
    @Test func aFiledCaptureOpenedFromOutsideStaysSelected() async throws {
        let scratch = try InboxTestVault()
        _ = await scratch.store.capture("[agent] stays in the inbox")
        _ = await scratch.store.capture("[agent] filed away")
        let filed = try #require(scratch.store.items.first { $0.title.contains("filed") })
        await scratch.store.file(filed, to: "Agent Test", tags: [])
        #expect(await scratch.store.fetch(filed.id)?.filedAtMs != nil)
        let router = InboxRouter()
        let window = show(Host(store: scratch.store, router: router))
        defer { window.isHidden = true }
        try await settle { router.selection != nil }

        router.openItem(filed.id, in: TasksRouter())
        try await settle { router.revealing == nil }
        try await Task.sleep(for: .milliseconds(300))
        #expect(router.selection == InboxDetailSelection(id: filed.id, explicit: true))
    }

    /// A type filter hides the opened capture. The filter stays, and so does
    /// the selection.
    @Test func aFilteredOutItemOpenedFromOutsideStaysSelected() async throws {
        let scratch = try InboxTestVault()
        _ = await scratch.store.capture("https://example.com/agent/1")
        _ = await scratch.store.capture("[agent] a note the filter hides")
        let note = try #require(scratch.store.items.first { $0.itemType == "note" })
        scratch.store.typeFilter = ["link"]
        let router = InboxRouter()
        let window = show(Host(store: scratch.store, router: router))
        defer { window.isHidden = true }
        try await settle { router.selection != nil }

        router.openItem(note.id, in: TasksRouter())
        try await settle { router.revealing == nil }
        try await Task.sleep(for: .milliseconds(300))
        #expect(scratch.store.typeFilter == ["link"])
        #expect(router.selection == InboxDetailSelection(id: note.id, explicit: true))
    }

    /// F6: a reveal still fetching when a newer outside open replaced it
    /// does not switch the list. The newer open names an item gone from the
    /// vault, so nothing switches the list back.
    @Test func aStaleRevealDoesNotSwitchTheList() async throws {
        let scratch = try InboxTestVault()
        let gated = GatedInbox(scratch.inbox)
        let store = InboxStore(
            core: gated, vaultId: "vault-inbox-test", vaultDirectory: scratch.directory, filler: nil,
            executor: CoreExecutor(label: "inbox-split-gated"), transcription: .scripted
        )
        await store.load()
        _ = await store.capture("[agent] stays in the inbox")
        _ = await store.capture("[agent] snoozed for later")
        let snoozed = try #require(store.items.first { $0.title.contains("snoozed") })
        await store.snooze([snoozed.id], until: Date().addingTimeInterval(3600))
        let router = InboxRouter()
        let window = show(Host(store: store, router: router))
        defer { window.isHidden = true }
        try await settle { router.selection != nil }

        gated.hold(snoozed.id)
        defer { gated.release() }
        router.openItem(snoozed.id, in: TasksRouter())
        try await settle { gated.waiting }
        #expect(gated.waiting)
        router.openItem("gone-from-the-vault", in: TasksRouter())
        gated.release()
        try await settle { router.revealing == nil }
        try await Task.sleep(for: .milliseconds(300))
        #expect(store.view == .inbox, "the stale reveal switched the list")
    }

    /// #4534: a Past reminder opened on Snoozed survives a trip through
    /// compact width without the list switching to Inbox, which also holds it.
    @Test func aPastReminderOnSnoozedKeepsItsListAcrossCompactAndBack() async throws {
        let scratch = try InboxTestVault()
        _ = await scratch.store.capture("[agent] remind me")
        let database = scratch.directory.appendingPathComponent(VaultFiles.dataDatabaseName).path
        let metadata = #"{"targetType":"task","targetId":"t1","targetTitle":"Decide"}"#
        try execute("""
            UPDATE sync_items SET payload = json_set(payload, '$.type', 'reminder', '$.metadata', json('\(metadata)')) WHERE item_type = 'inbox';
            UPDATE inbox_items SET type = 'reminder', metadata = '\(metadata)';
            """, in: database)
        await scratch.store.refresh()
        let reminder = try #require(scratch.store.items.first)
        await scratch.store.select(.snoozed)
        #expect(scratch.store.detailOrder == [reminder.id])
        let router = InboxRouter()
        let window = show(Host(store: scratch.store, router: router))
        defer { window.isHidden = true }
        try await settle { router.selection != nil }
        router.open(reminder.id)

        router.adapt(to: .compact)
        router.adapt(to: .regular)
        try await settle { router.revealing == nil }
        try await Task.sleep(for: .milliseconds(300))
        #expect(scratch.store.view == .snoozed, "the reveal switched the list")
        #expect(router.selection == InboxDetailSelection(id: reminder.id, explicit: true))
    }

    private func show(_ host: Host) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1366, height: 1024))
        window.rootViewController = UIHostingController(rootView: host)
        window.makeKeyAndVisible()
        return window
    }

    private func settle(_ done: () -> Bool) async throws {
        for _ in 0 ..< 40 where !done() {
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}

/// The real inbox, with `get` held for one id until the test releases it.
private final class GatedInbox: Inbox, @unchecked Sendable {
    private let lock = NSLock()
    private var held: String?
    private var entered = false
    private let gate = DispatchSemaphore(value: 0)

    init(_ inbox: Inbox) { super.init(unsafeFromHandle: inbox.uniffiCloneHandle()) }

    required init(unsafeFromHandle handle: UInt64) { super.init(unsafeFromHandle: handle) }

    var waiting: Bool { lock.withLock { entered } }

    func hold(_ id: String) { lock.withLock { held = id } }

    func release() {
        let wasHeld = lock.withLock {
            defer { held = nil; entered = false }
            return entered
        }
        if wasHeld { gate.signal() }
    }

    override func get(id: String) throws -> InboxItemRecord? {
        let waits = lock.withLock {
            guard held == id, !entered else { return false }
            entered = true
            return true
        }
        if waits { gate.wait() }
        return try super.get(id: id)
    }
}
