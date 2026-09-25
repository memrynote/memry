import MemryCore
import SwiftUI

// TP040, redesigned (RD01, RD02, RD12, RD14, RD15). The Tasks page after the
// Paper redesign (artboard 01): a large title with the title menu (the views,
// the project scope, starred saved filters, Projects), a subtitle line, one
// glass capsule with Filter and the … menu, the list (or the board), and a
// floating glass-prominent "+" that opens the composer above the keyboard.
// The Undo toast sits beside the "+".
//
// Select mode (artboard 14) is edit mode: the title counts the selection,
// "Select all" and a prominent checkmark take the bar, the rows show
// selection circles, and a glass bottom toolbar replaces the tab bar.
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
    @State private var showsScopePicker = false
    @State private var composer: TaskComposerRequest?
    /// The composer's typed title, kept when a tap outside closes it.
    @State private var composerText = ""
    /// The large title scrolled away: the inline title (with the system
    /// title menu) takes over.
    @State private var titleCollapsed = false

    private var isSelecting: Bool { editMode.isEditing }

    var body: some View {
        content
            .overlay {
                // A tap outside the composer closes it (the draft stays).
                if composer != nil {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { composer = nil }
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .bottom) { bottomOverlay }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let composer {
                    TaskComposer(store: store, request: composer, text: $composerText) { self.composer = nil }
                }
            }
            .environment(\.editMode, $editMode)
            .environment(\.taskBeginSelection, beginSelection)
            .environment(\.taskOpenComposer) { composer = $0 }
            .navigationTitle(titleCollapsed ? inlineTitle : "")
            .navigationSubtitle(titleCollapsed ? inlineSubtitle : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu {
                if !isSelecting {
                    TaskTitleMenu(
                        store: store,
                        openProjects: { router.open(.projects) },
                        searchProjects: { showsScopePicker = true }
                    )
                }
            }
            .toolbar { toolbar }
            .toolbar(isSelecting ? .hidden : .automatic, for: .tabBar)
            .taskKeyboardShortcuts(store: store, selection: $selection, visibleIds: store.listVisibleIds)
            .sheet(isPresented: $showsFilters) { TaskFilterSheet(store: store) }
            .sheet(isPresented: $showsScopePicker) { TaskListScopeSheet(store: store) }
            .onChange(of: isSelecting) { _, selecting in
                if !selecting { selection = [] }
                if selecting { composer = nil }
            }
            .onChange(of: store.state.tab) { _, _ in selection = [] }
            .onChange(of: selection.isEmpty) { _, isEmpty in
                // Cmd+A from a hardware keyboard selects without the menu.
                if !isEmpty, !isSelecting { editMode = .active }
            }
    }

    private var inlineTitle: String {
        isSelecting ? TasksCopy.selectedCount(selection.count) : store.listTitle
    }

    private var inlineSubtitle: String {
        isSelecting ? TasksCopy.selectDragHint(selection.count) : store.listSubtitle
    }

    private var titleHeader: TaskListTitleHeader {
        TaskListTitleHeader(
            store: store,
            selectedCount: isSelecting ? selection.count : nil,
            openProjects: { router.open(.projects) },
            searchProjects: { showsScopePicker = true }
        )
    }

    @ViewBuilder
    private var content: some View {
        if store.showsKanban {
            TaskKanbanBoard(store: store, titleCollapsed: $titleCollapsed) { titleHeader }
        } else {
            TaskListBody(store: store, selection: $selection, titleCollapsed: $titleCollapsed) { titleHeader }
        }
    }

    /// The Undo toast, and the "+" beside it when nothing else owns the
    /// bottom of the screen.
    private var bottomOverlay: some View {
        HStack(alignment: .center, spacing: Tokens.Space.medium) {
            TasksToast(store: store)
            if composer == nil, !isSelecting {
                FloatingAddButton(
                    label: TasksCopy.addTask,
                    hint: TasksCopy.addButtonHint,
                    identifier: "tasks.addButton"
                ) { composer = TaskComposerRequest(projectId: store.state.projectId) }
            }
        }
        .padding(.horizontal, Tokens.Space.inset)
        .padding(.bottom, Tokens.Space.medium)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if isSelecting {
            ToolbarItem(placement: .topBarLeading) {
                TaskSelectAllButton(selection: $selection, visibleIds: store.listVisibleIds)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editMode = .inactive
                } label: {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Tokens.Tint.foreground.color)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .accessibilityLabel(TasksCopy.selectDoneLabel)
                .accessibilityIdentifier("tasks.editButton")
            }
            TaskSelectionToolbar(store: store, selection: $selection)
        } else {
            ToolbarItemGroup(placement: .topBarTrailing) {
                filterButton
                TaskListMoreMenu(store: store) { editMode = .active }
            }
        }
    }

    private var filterButton: some View {
        let count = store.state.filters.activeCount
        return Button {
            showsFilters = true
        } label: {
            Image(systemName: count > 0
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease")
                .accessibilityLabel(TasksCopy.filter)
        }
        .accessibilityValue(count > 0 ? "\(count) \(TasksCopy.activeFilterCount)" : "")
        .accessibilityIdentifier("tasks.filterButton")
    }

    private func beginSelection(_ id: String) {
        editMode = .active
        selection.insert(id)
    }
}

extension EnvironmentValues {
    /// Enters select mode with one task selected (the row menu's Select).
    @Entry var taskBeginSelection: ((String) -> Void)?
    /// Opens the composer with presets (an empty state's "Add task for today",
    /// a board column's "+").
    @Entry var taskOpenComposer: ((TaskComposerRequest) -> Void)?
}
