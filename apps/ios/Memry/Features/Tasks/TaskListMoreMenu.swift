import MemryCore
import SwiftUI

// RD12. The list's … menu (Paper artboard 12): a medium icon row List /
// Board / Select, then Group by › and Sort › (desktop groups by the sort
// field; iOS keeps the device-local manual order inside each group), the
// board's Columns › when the board shows, Show completed, and Task settings.
//
// Desktop shows the board on the All view only (TP049), so Board moves the
// page to All; Select is the list's edit mode.

struct TaskListMoreMenu: View {
    let store: TasksStore
    let beginSelecting: () -> Void

    @Environment(TasksRouter.self) private var router

    var body: some View {
        Menu {
            ControlGroup {
                Button {
                    store.setViewMode(.list)
                } label: {
                    Label(TasksCopy.moreList, systemImage: "list.bullet")
                }
                .accessibilityIdentifier("tasks.more.list")
                Button {
                    Task {
                        if store.state.tab != .all { await store.selectTab(.all) }
                        store.setViewMode(.kanban)
                    }
                } label: {
                    Label(TasksCopy.moreBoard, systemImage: "rectangle.split.3x1")
                }
                .accessibilityIdentifier("tasks.more.board")
                Button(action: beginSelecting) {
                    Label(TasksCopy.moreSelect, systemImage: "checkmark.circle")
                }
                .disabled(store.showsKanban)
                .accessibilityIdentifier("tasks.more.select")
            }
            .controlGroupStyle(.menu)

            Section {
                if store.showsKanban {
                    Menu {
                        Picker(TasksCopy.moreColumns, selection: Binding(
                            get: { store.kanbanMode == .canonical ? .status : store.kanbanMode },
                            set: { store.setKanbanMode($0) }
                        )) {
                            ForEach(KanbanColumnMode.pickable) { mode in
                                Text(TasksCopy.kanbanModeLabel(mode)).tag(mode)
                            }
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Text(TasksCopy.moreColumns)
                        Text(TasksCopy.kanbanModeLabel(store.kanbanEffectiveMode))
                    }
                    .accessibilityIdentifier("tasks.kanban.columnMode")
                } else {
                    Menu {
                        Picker(TasksCopy.moreGroupBy, selection: Binding(
                            get: { store.state.sort.field },
                            set: { field in Task { await store.setSortField(field) } }
                        )) {
                            ForEach(TaskFilterOptions.groupFields, id: \.self) { field in
                                Text(TasksCopy.filterSortFieldLabel(field)).tag(field)
                            }
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Text(TasksCopy.moreGroupBy)
                        Text(TasksCopy.filterSortFieldLabel(store.state.sort.field))
                    }
                    .accessibilityIdentifier("tasks.filter.sortField")
                    Menu {
                        Picker(TasksCopy.moreSort, selection: Binding(
                            get: { store.state.sort.direction == "desc" ? "desc" : "asc" },
                            set: { direction in Task { await store.setSortDirection(direction) } }
                        )) {
                            Label(TasksCopy.sortAscending, systemImage: "arrow.up").tag("asc")
                            Label(TasksCopy.sortDescending, systemImage: "arrow.down").tag("desc")
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Text(TasksCopy.moreSort)
                        Text(store.state.sort.direction == "desc" ? TasksCopy.sortDescending : TasksCopy.sortAscending)
                    }
                    .accessibilityIdentifier("tasks.filter.sortDirection")
                }
                Toggle(TasksCopy.moreShowCompleted, isOn: Binding(
                    get: { store.showsCompleted },
                    set: { store.setShowsCompleted($0) }
                ))
                .accessibilityIdentifier("tasks.more.showCompleted")
            }

            Section {
                Button(TasksCopy.moreTaskSettings, systemImage: "gearshape") { router.openSettings(.tasks) }
                    .accessibilityIdentifier("tasks.settingsLink")
            }
        } label: {
            Image(systemName: "ellipsis")
                .accessibilityLabel(TasksCopy.moreMenuLabel)
        }
        .accessibilityIdentifier("tasks.moreMenu")
    }
}

extension TasksStore {
    /// Whether the list draws its Completed section (the … menu's "Show
    /// completed"; a device-local view choice, shown by default).
    var showsCompleted: Bool { state.hidesCompleted != true }

    func setShowsCompleted(_ shows: Bool) {
        state.hidesCompleted = shows ? nil : true
    }
}
