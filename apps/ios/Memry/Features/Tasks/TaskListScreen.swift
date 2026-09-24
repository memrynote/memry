import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP040 — the task list page.
struct TaskListScreen: View {
    let store: TasksStore

    var body: some View {
        List(store.result?.taskIds ?? [], id: \.self) { id in
            if let task = store.items[id] { TaskRowView(task: task, store: store) }
        }
        .navigationTitle(TasksCopy.title)
    }
}
