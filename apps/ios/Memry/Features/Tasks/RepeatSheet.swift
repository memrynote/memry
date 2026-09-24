import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP045 — repeat presets and custom rule.
struct RepeatSheet: View {
    let rule: RepeatRule?
    let repeatFrom: String?
    let anchorDate: String?
    let store: TasksStore
    let onCommit: (RepeatRule?, String?) -> Void

    var body: some View { EmptyView() }
}
