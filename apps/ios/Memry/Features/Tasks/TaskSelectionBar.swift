import MemryCore
import SwiftUI

// Phase 3 placeholder with the final signature; its Phase 4 block replaces it.

/// TP047 — the multi-select bulk bar.
struct TaskSelectionBar: View {
    let store: TasksStore
    @Binding var selection: Set<String>
    let visibleIds: [String]

    var body: some View { EmptyView() }
}
