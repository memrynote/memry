import MemryCore
import SwiftUI

// TP048 owns this file. Phase 3 placeholder.

extension TasksStore {
    /// Applies a saved filter's filters and sort to the page.
    func applySavedFilter(_ filter: SavedFilterItem) async {
        let config = SavedFilterConfig.decode(filter.configJson)
        await update { state in
            state.filters = config.filters
            if let sort = config.sort { state.sort = sort }
        }
    }
}
