import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP042 — the quick-add capture field.
struct QuickAddBar: View {
    let store: TasksStore
    var defaultProjectId: String?

    var body: some View { EmptyView() }
}

/// TP042 — the full Add Task sheet.
struct AddTaskSheet: View {
    let store: TasksStore
    var initialTitle: String = ""
    var parentId: String?
    var projectId: String?

    var body: some View { EmptyView() }
}
