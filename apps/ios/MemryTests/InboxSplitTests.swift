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
    /// does not hold: the list waits for the detail column to show Snoozed.
    @Test func anItemOpenedFromOutsideStaysUntilItsListShows() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.openItem("z", in: .snoozed, tasks: TasksRouter())
        router.follow(["a"], ["a"])
        #expect(router.revealing == .snoozed)
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
        router.revealed(["y", "z"])
        #expect(router.revealing == nil)
        #expect(router.selection == InboxDetailSelection(id: "z", explicit: true))
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

        router.openItem(snoozed.id, in: .snoozed, tasks: TasksRouter())
        try await settle { scratch.store.view == .snoozed && router.revealing == nil }
        #expect(scratch.store.view == .snoozed)
        #expect(router.selection == InboxDetailSelection(id: snoozed.id, explicit: true))
    }

    private func settle(_ done: () -> Bool) async throws {
        for _ in 0 ..< 40 where !done() {
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}
