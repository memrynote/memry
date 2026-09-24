import MemryCore
import SwiftUI

// TP048. Saved filters in the filter sheet, after desktop's
// `saved-filters-section.tsx` + `save-filter-dialog.tsx`: save the current
// filters and sort under a name, apply (tap again to clear), star, rename,
// delete, and reorder on a pushed screen. Each write is a core `filter`
// record, so it syncs to desktop.

/// The saved filters section of the filter sheet.
struct SavedFilterSection: View {
    let store: TasksStore
    @State private var isSaving = false
    @State private var renaming: SavedFilterItem?

    var body: some View {
        // Captured now: dismissing the alert clears `renaming` before the
        // submitted rename runs.
        let renameId = renaming?.id
        Section(TasksCopy.filterSavedTitle) {
            Button {
                isSaving = true
            } label: {
                Label(
                    store.state.filters.isActive ? TasksCopy.saveCurrentFilter : TasksCopy.saveFilterSetFirst,
                    systemImage: "star"
                )
                .frame(minHeight: Tokens.Size.minimumHitArea)
            }
            .disabled(!store.state.filters.isActive)
            .accessibilityIdentifier("tasks.filter.save")
            if store.savedFilters.isEmpty {
                Text(TasksCopy.noSavedFilters)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ForEach(store.savedFilters, id: \.id) { filter in
                SavedFilterRow(
                    filter: filter,
                    isActive: store.activeSavedFilterId == filter.id,
                    store: store,
                    onRename: { renaming = filter }
                )
            }
            if store.savedFilters.count > 1 {
                NavigationLink(TasksCopy.reorderFilters) {
                    SavedFilterReorderView(store: store)
                }
                .accessibilityIdentifier("tasks.savedFilter.reorder")
            }
        }
        .font(Tokens.Typography.body.font)
        .savedFilterNamePrompt(
            isPresented: $isSaving,
            title: TasksCopy.saveFilter,
            confirm: TasksCopy.saveFilter,
            initialName: ""
        ) { name in
            await store.saveCurrentFilter(name: name)
        }
        .savedFilterNamePrompt(
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
            title: TasksCopy.renameFilterTitle,
            confirm: TasksCopy.renameFilter,
            initialName: renaming?.name ?? ""
        ) { name in
            guard let renameId else { return false }
            return await store.renameSavedFilter(renameId, to: name)
        }
    }
}

/// One saved filter: star, name (tap applies), swipe/context for the rest.
struct SavedFilterRow: View {
    let filter: SavedFilterItem
    let isActive: Bool
    let store: TasksStore
    let onRename: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Button {
                Task { await store.toggleSavedFilterStar(filter) }
            } label: {
                Image(systemName: filter.starred ? "star.fill" : "star")
                    .foregroundStyle(filter.starred ? Tokens.Task.star.color : Tokens.Text.tertiary.color)
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(TasksCopy.starFilterLabel(filter.name, starred: filter.starred))
            .accessibilityIdentifier("tasks.savedFilter.star.\(filter.id)")
            Button {
                Task { await store.applySavedFilter(filter) }
            } label: {
                HStack {
                    Text(filter.name)
                        .fontWeight(isActive ? .semibold : .regular)
                        .foregroundStyle(isActive ? Tokens.Text.primary.color : Tokens.Text.secondary.color)
                        .lineLimit(1)
                    Spacer(minLength: Tokens.Space.small)
                    if isActive {
                        Image(systemName: "checkmark").accessibilityHidden(true)
                    }
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isActive ? .isSelected : [])
            .accessibilityHint(TasksCopy.savedFilterHint(active: isActive))
            .accessibilityIdentifier("tasks.savedFilter.\(filter.id)")
        }
        .swipeActions(edge: .trailing) {
            Button(TasksCopy.deleteFilter, role: .destructive) { delete() }
            Button(TasksCopy.renameFilter, action: onRename)
        }
        .contextMenu {
            Button(TasksCopy.renameFilter, systemImage: "pencil", action: onRename)
            Button(TasksCopy.deleteFilter, systemImage: "trash", role: .destructive) { delete() }
        }
        .accessibilityActions {
            Button(TasksCopy.renameFilter, action: onRename)
            Button(TasksCopy.deleteFilter) { delete() }
        }
    }

    /// Desktop deletes without asking and says so in a toast.
    private func delete() {
        let id = filter.id
        Task { await store.deleteSavedFilter(id) }
    }
}

/// The saved filters in edit mode, dragged into a new order.
struct SavedFilterReorderView: View {
    let store: TasksStore

    var body: some View {
        List {
            ForEach(store.savedFilters, id: \.id) { filter in
                Label(filter.name, systemImage: filter.starred ? "star.fill" : "line.3.horizontal.decrease")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            .onMove { source, destination in
                Task { await store.moveSavedFilters(from: source, to: destination) }
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle(TasksCopy.filterSavedTitle)
        .accessibilityIdentifier("tasks.savedFilter.reorderList")
    }
}
