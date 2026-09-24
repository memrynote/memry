import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP046 — subtasks of a task.
struct SubtasksSection: View {
    let parent: TaskItem
    let store: TasksStore

    var body: some View { EmptyView() }
}

/// TP046 — pick a parent task (same project / other projects, search).
struct ParentPickerSheet: View {
    let task: TaskItem
    let store: TasksStore

    var body: some View { EmptyView() }
}

extension View {
    /// TP046 — hosts the complete-parent, all-subtasks-done and delete-parent
    /// dialogs the store raises.
    func subtaskPrompts(store: TasksStore) -> some View { self }
}
