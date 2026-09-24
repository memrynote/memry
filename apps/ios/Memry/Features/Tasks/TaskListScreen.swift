import MemryCore
import SwiftUI

// TP040. The Tasks page, after desktop's `pages/tasks.tsx`: the scope tabs
// with counts, the project scope, List or Kanban (All tab only), the active
// filter chips, the list with its groups and Done section, pull to sync, and
// the capture bar at the bottom (desktop's `CaptureBar`). Edit mode selects
// rows for the bulk bar and the hardware-keyboard shortcuts.
//
// Every question about which tasks show and in what order is the core's
// (`store.result`); this screen lays the answer out and keeps view state in
// `store.state`, which the store persists.

/// TP040 — the task list page.
struct TaskListScreen: View {
    let store: TasksStore

    @Environment(TasksRouter.self) private var router
    @State private var editMode: EditMode = .inactive
    @State private var selection: Set<String> = []
    @State private var showsFilters = false
    @State private var showsAddTask = false
    @State private var addTaskDue: String?
    @State private var footerHeight: CGFloat = 0
    @State private var showsScopePicker = false

    var body: some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) { header }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                footer.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
            }
            .preference(key: TasksToastLiftKey.self, value: footerHeight)
            .environment(\.editMode, $editMode)
            .navigationTitle(TasksCopy.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .taskKeyboardShortcuts(store: store, selection: $selection, visibleIds: store.listVisibleIds)
            .sheet(isPresented: $showsFilters) { TaskFilterSheet(store: store) }
            .sheet(isPresented: $showsAddTask) {
                AddTaskSheet(store: store, projectId: store.state.projectId, dueDate: addTaskDue)
            }
            .sheet(isPresented: $showsScopePicker) { TaskListScopeSheet(store: store) }
            .onChange(of: editMode.isEditing) { _, isEditing in
                if !isEditing { selection = [] }
            }
            .onChange(of: store.state.tab) { _, _ in selection = [] }
    }

    @ViewBuilder
    private var content: some View {
        if store.showsKanban {
            TaskKanbanBoard(store: store)
        } else {
            TaskListBody(store: store, selection: $selection) {
                addTaskDue = emptyStateDue
                showsAddTask = true
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            TaskListHeader(store: store, showsScopePicker: $showsScopePicker)
            ActiveFilterChips(store: store)
            if let failure = store.failure {
                HStack(alignment: .top, spacing: Tokens.Space.small) {
                    ErrorNotice(error: failure, code: nil)
                    Button {
                        store.clearFailure()
                    } label: {
                        Image(systemName: "xmark")
                            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityLabel(TasksCopy.dismissError)
                    .accessibilityIdentifier("tasks.error.dismiss")
                }
                .padding(.horizontal, Tokens.Space.inset)
                .padding(.bottom, Tokens.Space.small)
            }
        }
        .background(Tokens.Canvas.background.color)
    }

    @ViewBuilder
    private var footer: some View {
        if editMode.isEditing {
            TaskSelectionBar(store: store, selection: $selection, visibleIds: store.listVisibleIds)
        } else {
            QuickAddBar(store: store, defaultProjectId: store.state.projectId)
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button(TasksCopy.projects, systemImage: "folder") { router.open(.projects) }
                    .accessibilityIdentifier("tasks.projectsLink")
                Button(TasksCopy.settings, systemImage: "gearshape") { router.open(.settings) }
                    .accessibilityIdentifier("tasks.settingsLink")
            } label: {
                Image(systemName: "ellipsis.circle")
                    .accessibilityLabel(TasksCopy.more)
            }
            .accessibilityIdentifier("tasks.moreMenu")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if !store.showsKanban {
                Button(editMode.isEditing ? TasksCopy.done : TasksCopy.select) {
                    editMode = editMode.isEditing ? .inactive : .active
                }
                .accessibilityIdentifier("tasks.editButton")
            }
            filterButton
            Button {
                addTaskDue = nil
                showsAddTask = true
            } label: {
                Image(systemName: "plus")
                    .accessibilityLabel(TasksCopy.addTask)
            }
            .accessibilityIdentifier("tasks.addButton")
        }
    }

    private var filterButton: some View {
        let count = store.state.filters.activeCount
        return Button {
            showsFilters = true
        } label: {
            Image(systemName: count > 0
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle")
                .accessibilityLabel(TasksCopy.filter)
        }
        .accessibilityValue(count > 0 ? "\(count) \(TasksCopy.activeFilterCount)" : "")
        .accessibilityIdentifier("tasks.filterButton")
    }

    /// The due date the empty state's "Add task for today/tomorrow" starts
    /// with, resolved by the core's date parser against the local clock.
    private var emptyStateDue: String? {
        let phrase: String? = switch store.state.tab {
        case .today: "today"
        case .tomorrow: "tomorrow"
        case .all, .next7, .archived: nil
        }
        return phrase.flatMap { parseTaskDate(input: $0, now: store.localNow())?.date }
    }
}
