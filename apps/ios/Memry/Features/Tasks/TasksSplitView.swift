import MemryCore
import SwiftUI

// #4350. Tasks at regular width: the views, projects and starred filters as
// the sidebar, the list (or the board) as the content column, and the task as
// the detail column (`DESIGN.md` › Tablet, "Lists and details"). Compact width
// keeps the phone stack in `TasksRootView`.
//
// **One owner.** ``TasksRouter/path`` holds the place; the list column's stack
// is its routes before the first task, the detail column shows that task and
// stacks what was opened from inside it. A row, a card, a search hit and a
// reminder tap all open through the router, so each lands in the detail
// column and the list stays beside it.
//
// **Columns (Q4).** Three at 13" landscape width, two below it (the list and
// the task, the sidebar a tap away), as in Notes.
//
// **The board uses the full pane** (`DESIGN.md` › Tablet, "Measures"). As a
// content column the system clamps it to about half the window, one column
// and a sliver. So the board is the split view's detail, the scopes a tap
// away, and a card's task pushes over the board on the router's whole path,
// as on the phone. Back returns to the board.

struct TasksSplitView: View {
    let store: TasksStore
    @Environment(TasksRouter.self) private var router

    @State private var columns: NavigationSplitViewVisibility = .doubleColumn
    @State private var holdsThreeColumns = false
    /// The width Notes uses: 13" landscape, and no smaller iPad.
    private static let threeColumnWidth: CGFloat = 1300
    private static let listWidth: CGFloat = 360

    var body: some View {
        Group {
            if store.showsKanban {
                NavigationSplitView(columnVisibility: $columns) {
                    TasksScopeSidebar(store: store)
                } detail: {
                    boardStack
                }
            } else {
                NavigationSplitView(columnVisibility: $columns) {
                    TasksScopeSidebar(store: store)
                } content: {
                    listStack.navigationSplitViewColumnWidth(
                        min: Self.listWidth, ideal: Self.listWidth, max: Self.listWidth * 1.4
                    )
                } detail: {
                    detailStack
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onGeometryChange(for: Bool.self) { $0.size.width >= Self.threeColumnWidth } action: {
            holdsThreeColumns = $0
        }
        // Once the layout settles: while the page sidebar slides in, the split
        // view writes its own choice over the binding (see `NotesSplitView`).
        .task(id: ColumnsKey(wide: holdsThreeColumns, board: store.showsKanban)) {
            guard (try? await Task.sleep(for: .milliseconds(400))) != nil else { return }
            columns = store.showsKanban ? .detailOnly : holdsThreeColumns ? .all : .doubleColumn
        }
    }

    private var listStack: some View {
        @Bindable var router = router
        return NavigationStack(path: $router.listPath) {
            TaskListScreen(store: store)
                .tasksDestinations(store: store)
        }
        .tasksToast(store: store, over: router.listPath)
    }

    private var boardStack: some View {
        @Bindable var router = router
        return NavigationStack(path: $router.path) {
            TaskListScreen(store: store)
                .tasksDestinations(store: store)
        }
        .tasksToast(store: store, over: router.path)
    }

    private var detailStack: some View {
        @Bindable var router = router
        return NavigationStack(path: $router.detailPath) {
            Group {
                if let id = router.detailTask {
                    TaskDetailView(taskId: id, store: store).id(id)
                } else {
                    TasksEmptyDetail()
                }
            }
            .tasksDestinations(store: store)
        }
    }

    private struct ColumnsKey: Equatable {
        let wide: Bool
        let board: Bool
    }
}

/// A row or a card's link to its task. On the phone stack it is the stack's
/// value link, as before. In the split view it opens through the router, so
/// the task fills the detail column instead of pushing over the list, and the
/// open task's row shows desktop's active-row fill.
struct TaskOpenLink<Label: View>: View {
    let id: String
    @ViewBuilder let label: () -> Label
    @Environment(TasksRouter.self) private var router: TasksRouter?

    var body: some View {
        if let router, router.tasksSplit {
            Button { router.open(.task(id)) } label: {
                label().background {
                    if router.detailTask == id {
                        RoundedRectangle(cornerRadius: Tokens.Radius.small)
                            .fill(Tokens.Canvas.surfaceActive.color)
                            .padding(-Tokens.Space.tight)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(router.detailTask == id ? .isSelected : [])
        } else {
            NavigationLink(value: TasksRoute.task(id)) { label() }
        }
    }
}

/// No task open: a plain empty state (D6).
private struct TasksEmptyDetail: View {
    var body: some View {
        ContentUnavailableView {
            Label(TasksCopy.noTaskOpen, systemImage: "checkmark.circle")
        } description: {
            Text(TasksCopy.noTaskOpenDetail)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.Canvas.background.color)
        .accessibilityIdentifier("tasks.detail.empty")
    }
}

extension TasksCopy {
    static let noTaskOpen = "No task open"
    static let noTaskOpenDetail = "Choose a task from the list."
}
