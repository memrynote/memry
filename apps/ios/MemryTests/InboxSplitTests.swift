import Testing

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

    @Test func anItemOpenedFromOutsideTheListStays() {
        #expect(InboxDetailSelection.next(after: picked("z"), old: ["a", "b"], new: ["a"]) == picked("z"))
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

    @Test func anItemTheAppSelectedIsNotPushedAtCompactWidth() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.follow([], ["a"])
        router.adapt(to: .compact)
        #expect(router.path.isEmpty)
    }
}
