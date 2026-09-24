import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP045 — repeat presets and custom rule.
struct RepeatSheet: View {
    /// The task being edited; `nil` while composing a new task.
    let taskId: String?
    let rule: RepeatRule?
    let repeatFrom: String?
    let anchorDate: String?
    let store: TasksStore
    let onCommit: (RepeatRule?, String?) -> Void

    var body: some View { EmptyView() }
}

extension View {
    /// TP045 — hosts the Stop Repeating / Edit Repeating dialogs the store raises.
    func repeatPrompts(store: TasksStore) -> some View { self }
}
