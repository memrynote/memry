import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP043 — a task's detail screen.
struct TaskDetailView: View {
    let taskId: String
    let store: TasksStore

    var body: some View { Text(store.items[taskId]?.title ?? "") }
}
