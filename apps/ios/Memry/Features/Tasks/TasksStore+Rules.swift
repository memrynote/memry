import Foundation
import MemryCore

// The advanced filter over the store. The tree is `state.filters.expression`;
// every edit goes through ``updateFilters(_:)``, so the core re-runs the page
// query with it and the applied saved filter is forgotten, as on desktop.

extension TasksStore {
    /// The rules the page applies; a fresh `all` group when there are none.
    var rules: TaskFilterNode { state.filters.expression ?? .group("all") }

    /// Rules the core evaluates, skipped ones (no value, newer build) left out.
    var ruleCount: Int { state.filters.expression == nil ? 0 : Int(result?.ruleCount ?? 0) }

    /// The filter button's count: the chips plus each evaluable rule, as
    /// desktop's `countActiveFilters`.
    var activeFilterCount: Int {
        var chips = state.filters
        chips.expression = nil
        return chips.activeCount + ruleCount
    }

    /// Opening the builder moves the chips into rules, once, when there are
    /// no rules yet, so the list does not change under it.
    func beginRuleEditing() async {
        guard state.filters.expression == nil else { return }
        let seeded = state.filters.seededWithRules()
        guard seeded.expression != nil else { return }
        await updateFilters { $0 = seeded }
    }

    /// Edits the tree; a tree left with no rules is stored as none.
    func editRules(_ change: (TaskFilterNode) -> TaskFilterNode?) async {
        let next = change(rules).flatMap { $0.rules.isEmpty ? nil : $0 }
        await updateFilters { $0.expression = next }
    }

    func updateRule(at path: [Int], _ change: @escaping (TaskFilterNode) -> TaskFilterNode?) async {
        await editRules { $0.updating(at: path, change) }
    }

    func appendRule(_ node: TaskFilterNode, toGroupAt path: [Int]) async {
        await editRules { $0.appending(node, at: path) }
    }

    func clearRules() async {
        await updateFilters { $0.expression = nil }
    }
}
