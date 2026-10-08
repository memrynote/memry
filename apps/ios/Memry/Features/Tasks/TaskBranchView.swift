import MemryCore
import SwiftUI

// #2868, Paper "Features" › task-sub › G1. One branch of the tree as its own
// screen: the parent as the title, its subtasks drawn the way the list draws
// them (two levels, deeper parents push again), and "Add subtask" when the
// core allows one here. The back button carries the previous screen's title,
// so the navigation stack is the path; there is no breadcrumb bar.

struct TaskBranchView: View {
    let parentId: String
    let store: TasksStore

    @State private var isAdding = false

    var body: some View {
        Group {
            if let parent = store.items[parentId] {
                list(parent)
                    .navigationTitle(parent.title)
                    .navigationBarTitleDisplayMode(.large)
            } else {
                ContentUnavailableView(
                    TasksCopy.Detail.taskMissingTitle,
                    systemImage: "questionmark.circle",
                    description: Text(TasksCopy.Detail.taskMissingDetail)
                )
            }
        }
        .accessibilityIdentifier("tasks.branch")
    }

    private func list(_ parent: TaskItem) -> some View {
        let children = store.treeChildren(of: parent.id)
        let rows = children.flatMap { store.treeRows($0.id) }
        return List {
            Group {
                Text(TasksCopy.treeBranchProgress(done: children.filter(\.isDone).count, total: children.count))
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(
                        top: 0, leading: TaskLayout.edge, bottom: Tokens.Space.small, trailing: TaskLayout.edge
                    ))
                    .accessibilityIdentifier("tasks.branch.progress")
                ForEach(rows) { row in
                    if let task = store.items[row.id] {
                        TaskRowView(
                            task: task,
                            store: store,
                            depth: row.depth,
                            context: TaskMeta.Context(showsProject: false)
                        )
                    }
                }
                if store.canAddSubtask(parent.id) {
                    SubtaskAddField(parent: parent, store: store, isActive: $isAdding)
                        .listRowInsets(EdgeInsets(
                            top: 0, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge
                        ))
                }
            }
            .listRowBackground(Tokens.Canvas.background.color)
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .refreshable { await store.sync() }
    }
}

/// The count and chevron on a row whose subtasks the list does not draw;
/// tapping it pushes the branch.
struct TaskBranchChip: View {
    let task: TaskItem
    let store: TasksStore

    var body: some View {
        let children = store.treeChildren(of: task.id)
        NavigationLink(value: TasksRoute.branch(task.id)) {
            HStack(spacing: Tokens.Space.tight) {
                Text("\(children.filter(\.isDone).count)/\(children.count)").monospacedDigit()
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .padding(.horizontal, Tokens.Space.small)
            .padding(.vertical, Tokens.Space.tight)
            .background(Tokens.Canvas.surfaceActive.color, in: .capsule)
            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .navigationLinkIndicatorVisibility(.hidden)
        .buttonStyle(.plain)
        .accessibilityIdentifier("tasks.row.branch.\(task.id)")
    }
}

/// VoiceOver reads a row as one element, so the chip is a named action.
struct TaskBranchAccessibility: ViewModifier {
    let enabled: Bool
    let open: () -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.accessibilityAction(named: TasksCopy.treeOpenBranch, open)
        } else {
            content
        }
    }
}

/// The long-press menu's tree moves (desktop's `subtaskTree.menu`): under the
/// sibling above, out one level, the "Move under…" picker, and top level. Each
/// shows only when the core's tree allows it.
struct TaskTreeMenuSection: View {
    let task: TaskItem
    let store: TasksStore
    let pickParent: () -> Void

    var body: some View {
        let entry = store.tree[task.id]
        Section {
            if let above = entry?.indentUnder.flatMap({ store.items[$0] }) {
                Button(TasksCopy.treeIndent(above.title), systemImage: "increase.indent") {
                    let task = task
                    Task { await store.indent(task) }
                }
                .accessibilityIdentifier("tasks.row.menu.indent")
            }
            if entry?.outdentTo != nil {
                Button(TasksCopy.treeOutdent, systemImage: "decrease.indent") {
                    let task = task
                    Task { await store.outdent(task) }
                }
                .accessibilityIdentifier("tasks.row.menu.outdent")
            }
            Button(TasksCopy.treeMoveUnder, systemImage: "arrow.turn.down.right", action: pickParent)
                .accessibilityIdentifier("tasks.row.menu.moveUnder")
            if entry?.parentId != nil {
                Button(TasksCopy.treeTopLevel, systemImage: "arrow.up.to.line") {
                    let task = task
                    Task { await store.promoteToTask(task) }
                }
                .accessibilityIdentifier("tasks.row.menu.topLevel")
            }
        }
    }
}
