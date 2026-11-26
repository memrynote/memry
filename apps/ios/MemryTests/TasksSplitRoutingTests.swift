import Testing

@testable import Memry

// #4350: at regular width Tasks is a split view over the same path the phone
// stack uses. The routes before the first task are the list column, the task
// is the detail column, and what follows it is the detail column's stack.

@MainActor
@Suite("Tasks split routing")
struct TasksSplitRoutingTests {
    @Test func the_phone_stack_pushes_every_route() {
        let router = TasksRouter()
        router.open(.projects)
        router.open(.task("a"))
        router.open(.task("b"))
        #expect(router.path == [.projects, .task("a"), .task("b")])
        router.openTask("c")
        #expect(router.path == [.task("c")])
    }

    @Test func a_task_fills_the_detail_column_and_keeps_the_list() {
        let router = split([.project("p")])
        router.open(.task("a"))
        router.open(.task("b"))
        #expect(router.listPath == [.project("p")])
        #expect(router.detailTask == "b")
        #expect(router.detailPath.isEmpty)
    }

    @Test func a_search_hit_or_a_reminder_opens_in_the_detail_column() {
        let router = split([.projects, .task("a"), .branch("a")])
        router.selectedTab = .notes
        router.openTask("b")
        #expect(router.selectedTab == .tasks)
        #expect(router.path == [.projects, .task("b")])
    }

    @Test func a_list_page_goes_on_the_list_column_under_the_open_task() {
        let router = split([.task("a")])
        router.open(.branch("p"))
        #expect(router.path == [.branch("p"), .task("a")])
    }

    @Test func the_columns_write_their_part_of_the_path() {
        let router = split([.projects, .task("a")])
        router.detailPath = [.task("sub")]
        #expect(router.path == [.projects, .task("a"), .task("sub")])
        router.listPath = []
        #expect(router.path == [.task("a"), .task("sub")])
        // A task pushed by a link in the list column becomes the detail.
        router.listPath = [.projects, .task("b")]
        #expect(router.listPath == [.projects])
        #expect(router.detailTask == "b")
    }

    @Test func closing_the_task_empties_the_detail_column() {
        let router = split([.projects, .task("a"), .task("sub")])
        router.closeTask()
        #expect(router.path == [.projects])
        #expect(router.detailTask == nil)
        router.detailPath = [.task("x")]
        #expect(router.path == [.projects], "no task, no detail stack")
    }

    private func split(_ path: [TasksRoute]) -> TasksRouter {
        let router = TasksRouter()
        router.setTasksSplit(true)
        router.path = path
        return router
    }
}
