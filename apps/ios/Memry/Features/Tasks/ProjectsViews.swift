import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP052 — every project.
struct ProjectsListView: View {
    let store: TasksStore

    var body: some View { EmptyView() }
}

/// TP052 — one project's hub.
struct ProjectHubView: View {
    let projectId: String
    let store: TasksStore

    var body: some View { EmptyView() }
}

/// TP052 — create or edit a project.
struct ProjectEditorSheet: View {
    let store: TasksStore
    let projectId: String?

    var body: some View { EmptyView() }
}
