import Foundation
import MemryCore
import SwiftUI

// TP048. Filters, sort/group and saved filters over the store.
//
// Every edit writes `state.filters` / `state.sort` through ``update(_:)``, so
// the core re-runs the page query and the view state persists. Saved filters
// are the core's `filter` records (create, rename, star, reorder, delete via
// ``run(_:)``, which refreshes and syncs); their config is desktop's JSON.
//
// **The applied saved filter** is page state desktop keeps
// (`activeSavedFilterId`). `TasksViewState` has no field for it, so it lives in
// ``scratch`` for the session: any manual filter edit clears it, as on desktop.

extension TasksStore {
    private static let activeSavedFilterKey = "filters.activeSavedFilterId"

    // MARK: Filters

    /// The saved filter the page is showing, if it still exists.
    var activeSavedFilterId: String? {
        guard let id = scratch[Self.activeSavedFilterKey], savedFilters.contains(where: { $0.id == id }) else {
            return nil
        }
        return id
    }

    /// Forgets the applied saved filter without touching the filters.
    func forgetSavedFilter() {
        scratch[Self.activeSavedFilterKey] = nil
    }

    /// `updateFiltersAndClearSaved`: edits the filters and forgets the applied
    /// saved filter.
    func updateFilters(_ change: (inout TaskFilterSpec) -> Void) async {
        scratch[Self.activeSavedFilterKey] = nil
        var filters = state.filters
        change(&filters)
        let next = filters
        await update { $0.filters = next }
    }

    /// Clears one chip's dimension.
    func clearFilterChip(_ chip: TaskFilterChip) async {
        let next = chip.cleared(state.filters)
        await updateFilters { $0 = next }
    }

    /// `clearFiltersAndClearSaved`: every dimension back to its default.
    func clearFilters() async {
        await updateFilters { $0 = TaskFilterSpec() }
        showFilterToast(TasksCopy.filtersCleared)
    }

    /// `QuickFilters.handleApply`: a preset replaces the filters; tapping the
    /// active one clears them.
    func applyQuickPreset(_ preset: TaskFilterPreset) async {
        let active = TaskFilterPreset.active(in: state.filters)
        await updateFilters { $0 = active == preset ? TaskFilterSpec() : preset.filters }
    }

    /// Picks a due preset (clearing any custom range).
    func setDueFilter(_ type: String) async {
        await updateFilters { $0.dueDate = DueDateFilterSpec(type: type) }
    }

    /// A custom due range, both ends inclusive, as `YYYY-MM-DD` keys.
    func setDueFilterRange(from start: Date, to end: Date) async {
        let first = min(start, end)
        let last = max(start, end)
        let range = DueDateFilterSpec(type: "custom", customStart: TaskDates.key(first), customEnd: TaskDates.key(last))
        await updateFilters { $0.dueDate = range }
    }

    /// Adds or removes a value from a multi-select dimension.
    static func toggled(_ value: String, in values: [String]) -> [String] {
        values.contains(value) ? values.filter { $0 != value } : values + [value]
    }

    /// Tags compare case-insensitively (`toggleTag`).
    static func toggledTag(_ tag: String, in tags: [String]) -> [String] {
        let lower = tag.lowercased()
        return tags.contains { $0.lowercased() == lower } ? tags.filter { $0.lowercased() != lower } : tags + [tag]
    }

    /// Every tag on a live task with how many tasks carry it, by name. Desktop
    /// lists the vault's note tags; the task surface has only task tags.
    var filterTags: [(tag: String, count: Int)] {
        var counts: [String: (tag: String, count: Int)] = [:]
        for task in ordered where task.archivedAt == nil {
            for tag in task.tags {
                let key = tag.lowercased()
                counts[key] = (counts[key]?.tag ?? tag, (counts[key]?.count ?? 0) + 1)
            }
        }
        return counts.values.sorted { $0.tag.localizedStandardCompare($1.tag) == .orderedAscending }
    }

    // MARK: Sort and group

    /// The group-by field (desktop groups by the sort field).
    func setSortField(_ field: String) async {
        await update { $0.sort.field = field }
    }

    func setSortDirection(_ direction: String) async {
        await update { $0.sort.direction = direction }
    }

    func isGroupCollapsed(_ key: String) -> Bool {
        state.collapsedGroups.contains(key)
    }

    /// Collapses or expands a group; the choice persists with the view state.
    func toggleGroupCollapsed(_ key: String) {
        if state.collapsedGroups.contains(key) {
            state.collapsedGroups.remove(key)
        } else {
            state.collapsedGroups.insert(key)
        }
    }

    // MARK: Saved filters

    /// Applies a saved filter's filters and sort to the page; applying the
    /// one already applied clears the filters (`handleApplySavedFilter`).
    func applySavedFilter(_ filter: SavedFilterItem) async {
        if activeSavedFilterId == filter.id {
            await updateFilters { $0 = TaskFilterSpec() }
            return
        }
        let config = SavedFilterConfig.decode(filter.configJson)
        await update { state in
            state.filters = config.filters
            if let sort = config.sort { state.sort = sort }
        }
        scratch[Self.activeSavedFilterKey] = filter.id
        showFilterToast(TasksCopy.filterApplied(filter.name))
    }

    /// Saves the current filters and sort under a name; the new filter becomes
    /// the applied one. Returns false when the name is invalid or the write
    /// failed (the failure is already reported).
    @discardableResult
    func saveCurrentFilter(name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard TaskFilterOptions.isValidSavedFilterName(trimmed) else { return false }
        let json = SavedFilterConfig(filters: state.filters, sort: state.sort, starred: false).json
        guard let id = await run({ try $0.createSavedFilter(name: trimmed, configJson: json) }) else { return false }
        scratch[Self.activeSavedFilterKey] = id
        showFilterToast(TasksCopy.filterSaved)
        return true
    }

    @discardableResult
    func renameSavedFilter(_ id: String, to name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard TaskFilterOptions.isValidSavedFilterName(trimmed) else { return false }
        return await run { try $0.updateSavedFilter(id: id, name: trimmed, configJson: nil) } != nil
    }

    func toggleSavedFilterStar(_ filter: SavedFilterItem) async {
        let id = filter.id
        let starred = !filter.starred
        await run { try $0.setSavedFilterStarred(id: id, starred: starred) }
    }

    /// `handleDeleteSavedFilter`: deleting the applied filter clears the page.
    func deleteSavedFilter(_ id: String) async {
        let wasActive = activeSavedFilterId == id
        guard await run({ try $0.deleteSavedFilter(id: id) }) != nil else { return }
        if wasActive { await updateFilters { $0 = TaskFilterSpec() } }
        showFilterToast(TasksCopy.filterDeleted)
    }

    /// `List.onMove` over the saved filters, written as new positions.
    func moveSavedFilters(from source: IndexSet, to destination: Int) async {
        var ids = savedFilters.map(\.id)
        ids.move(fromOffsets: source, toOffset: destination)
        guard ids != savedFilters.map(\.id) else { return }
        let order = ids
        await run { try $0.reorderSavedFilters(ids: order) }
    }

    /// A confirmation with nothing to undo: it replaces the toast, and the
    /// older change's Undo goes with it so the button cannot act on a change
    /// the toast no longer names.
    private func showFilterToast(_ message: String) {
        undoable = nil
        toast = message
    }
}
