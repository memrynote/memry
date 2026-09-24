import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP041 — one task row.
struct TaskRowView: View {
    let task: TaskItem
    let store: TasksStore
    var depth: Int = 0

    var body: some View {
        NavigationLink(value: TasksRoute.task(task.id)) { Text(task.title) }
    }
}
