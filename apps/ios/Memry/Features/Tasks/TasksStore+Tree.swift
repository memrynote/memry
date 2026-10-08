import MemryCore

// #2868. Subtasks at any depth on the phone (Paper "Features" › task-sub, G1).
// The tree and every placement rule are the core's (`Tasks::tree`,
// `Tasks::move_under_places`): which parent a task sits under, which moves
// stay out of the task's own branch, and the device-local
// `tasks.nestedSubtasks` gate. This file lays the answer out and names the
// writes, which all go through `setParent`.
//
// **Depth is a push, not an indent.** The list draws at most two levels under
// a row (`maxListDepth`). A row whose children are not drawn shows their count
// and a chevron, and tapping it pushes that branch as its own screen.

extension TasksStore {
    /// The deepest level a list draws under its top rows: 0, 1 and 2.
    static let maxListDepth = 2

    // MARK: Reading

    /// The task's unarchived children in the tree, in position order.
    func treeChildren(of id: String) -> [TaskItem] {
        (tree[id]?.childIds ?? []).compactMap { items[$0] }
    }

    /// `id` and the rows riding under it, from `depth`, cut at `maxListDepth`.
    func treeRows(_ id: String, depth: Int = 0) -> [TaskListRow] {
        let row = TaskListRow(id: id, depth: depth)
        guard depth < Self.maxListDepth else { return [row] }
        return [row] + (tree[id]?.childIds ?? []).flatMap { treeRows($0, depth: depth + 1) }
    }

    /// Whether a row at `depth` has children the list does not draw, so it
    /// shows the count and chevron that push its branch.
    func pushesBranch(_ id: String, depth: Int) -> Bool {
        depth >= Self.maxListDepth && !(tree[id]?.childIds.isEmpty ?? true)
    }

    /// Whether a new subtask may go under the task.
    func canAddSubtask(_ id: String) -> Bool {
        tree[id]?.canAddSubtask ?? false
    }

    /// The "Move under…" picker's rows: the task's project as the tree.
    func moveUnderPlaces(for task: TaskItem) async -> [TaskPlace] {
        let id = task.id
        return await read { try $0.moveUnderPlaces(taskId: id) } ?? []
    }

    // MARK: Writing

    /// "Move under {title}": under the sibling above.
    func indent(_ task: TaskItem) async {
        guard let target = tree[task.id]?.indentUnder.flatMap({ items[$0] }) else { return }
        await moveUnder(task, parentId: target.id, title: target.title)
    }

    /// "Move out one level": under the grandparent.
    func outdent(_ task: TaskItem) async {
        guard let target = tree[task.id]?.outdentTo.flatMap({ items[$0] }) else { return }
        await moveUnder(task, parentId: target.id, title: target.title)
    }

    /// A pick from "Move under…".
    func moveUnder(_ task: TaskItem, parentId: String, title: String) async {
        scratch[Self.parentPickerScratchKey] = nil
        let id = task.id
        await perform(TasksCopy.subtaskMovedUnder(title)) { try $0.setParent(id: id, parentId: parentId) }
    }
}

extension TasksCopy {
    /// `subtaskTree.menu.*`.
    static let treeMoveUnder = "Move under…"
    static func treeIndent(_ title: String) -> String { "Move under \(title)" }
    static let treeOutdent = "Move out one level"
    static let treeTopLevel = "Make top-level task"
    static let treeOpenBranch = "Open subtasks"
    static let treeMoveUnderEmpty = "No matching task"
    static let treeThisTask = "This task"

    static func treeBranchProgress(done: Int, total: Int) -> String { "\(done) of \(total) done" }

    /// `settings.tasks.nestedSubtasks`.
    static let settingsNestedSubtasks = "Subtasks inside subtasks"
    static let settingsNestedSubtasksHelp =
        "Nest subtasks at any depth. Devices on older versions only show the first level until they update."
}
