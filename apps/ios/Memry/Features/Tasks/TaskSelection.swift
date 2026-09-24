import Foundation

// TP047. The multi-select set's operations, after desktop's
// `hooks/use-task-selection.ts`. The selection itself is a `Set<String>` the
// list owns and hands to ``TaskSelectionBar`` as a binding; these helpers keep
// the desktop rules in one place so the list, the bar and the keyboard agree.

extension Set<String> {
    /// Adds every visible id between `from` and `to`, both included, in
    /// either direction (`selectRange`, shift+click on desktop).
    ///
    /// With no anchor, or an anchor or target the page no longer shows, only
    /// `to` is added, as on desktop.
    mutating func selectRange(from anchor: String?, to target: String, in visibleIds: [String]) {
        guard let anchor,
              let start = visibleIds.firstIndex(of: anchor),
              let end = visibleIds.firstIndex(of: target) else {
            insert(target)
            return
        }
        formUnion(visibleIds[Swift.min(start, end) ... Swift.max(start, end)])
    }

    /// Whether every visible task is selected (`allSelected`); an empty page
    /// never is.
    func containsAll(of visibleIds: [String]) -> Bool {
        !visibleIds.isEmpty && visibleIds.allSatisfy(contains)
    }

    /// Selects exactly the visible tasks (`selectAll`); an empty page leaves
    /// the selection alone.
    mutating func selectAll(in visibleIds: [String]) {
        guard !visibleIds.isEmpty else { return }
        self = Set(visibleIds)
    }

    /// Select all when not everything is selected, clear otherwise
    /// (`toggleSelectAll`).
    mutating func toggleAll(in visibleIds: [String]) {
        if containsAll(of: visibleIds) {
            removeAll()
        } else {
            selectAll(in: visibleIds)
        }
    }
}
