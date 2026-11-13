import Testing

@testable import Memry

// #4355: ↑ ↓ over a list beside a detail column, and Return to open.

@MainActor
@Suite("List keys")
struct ListKeysTests {
    private let ids = ["a", "b", "c"]

    @Test func arrows_move_one_row_and_stop_at_the_ends() {
        #expect(ListKeys.step(ids, from: "b", by: 1) == "c")
        #expect(ListKeys.step(ids, from: "b", by: -1) == "a")
        #expect(ListKeys.step(ids, from: "c", by: 1) == nil)
        #expect(ListKeys.step(ids, from: "a", by: -1) == nil)
    }

    @Test func with_no_row_in_the_list_selected_down_takes_the_first_and_up_the_last() {
        #expect(ListKeys.step(ids, from: nil, by: 1) == "a")
        #expect(ListKeys.step(ids, from: "gone", by: -1) == "c")
        #expect(ListKeys.step([], from: nil, by: 1) == nil)
    }

    /// Desktop marks a reminder viewed only when it is opened, never when the
    /// list's focus passes over it (`use-inbox-keyboard.ts`).
    @Test func inbox_arrows_show_an_item_and_return_marks_it_opened() {
        let router = InboxRouter()
        router.adapt(to: .regular)
        router.path = [.inboxSettings]
        router.focus("b")
        #expect(router.selection == InboxDetailSelection(id: "b", explicit: false))
        #expect(router.path.isEmpty)
        router.open("b")
        #expect(router.selection == InboxDetailSelection(id: "b", explicit: true))
    }

    @Test func inbox_arrows_do_nothing_on_the_phone_stack() {
        let router = InboxRouter()
        router.focus("b")
        #expect(router.selection == nil)
        #expect(router.path.isEmpty)
    }
}
