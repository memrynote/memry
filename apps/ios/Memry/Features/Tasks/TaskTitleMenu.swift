import MemryCore
import SwiftUI

// RD01 / RD02. What the list's large title and subtitle say, and the title
// menu under the title (Paper artboard 02), which replaces the scrolling
// tab strip and the "All projects" pill: the five views with their counts,
// the project scope (with its search), the starred saved filters, and the
// way to the projects list.
//
// The title names the one place the list shows: an applied saved filter,
// else a project on the All view, else the view. The subtitle says what the
// title does not: the date on Today and Tomorrow, the done count, the scope,
// the board's columns and that filters narrow the list.

extension TasksStore {
    /// Top-level open and done rows in the current answer (subtasks ride
    /// with their parents, as the list draws them).
    var listCounts: (open: Int, done: Int) {
        guard let result else { return (0, 0) }
        let open = result.taskIds.filter { items[$0]?.parentId == nil }.count
        let done = result.doneIds.filter { items[$0]?.parentId == nil }.count
        return (open, done)
    }

    /// The count a view shows in the title menu.
    func tabCount(_ tab: TasksTab) -> Int {
        guard let counts = result?.counts else { return 0 }
        switch tab {
        case .all: return Int(counts.all)
        case .today: return Int(counts.today)
        case .tomorrow: return Int(counts.tomorrow)
        case .next7: return Int(counts.next7)
        case .archived: return Int(counts.archived)
        }
    }

    var activeSavedFilter: SavedFilterItem? {
        guard let id = activeSavedFilterId else { return nil }
        return savedFilters.first { $0.id == id }
    }

    /// The large title.
    var listTitle: String {
        if let filter = activeSavedFilter { return filter.name }
        if state.tab == .all, let project = project(state.projectId) { return project.name }
        return TasksCopy.tabTitle(state.tab)
    }

    /// The line under the title, e.g. "Thursday, Sep 24 · 3 of 9 done".
    var listSubtitle: String {
        let counts = listCounts
        let total = counts.open + counts.done
        var parts: [String] = []
        if activeSavedFilter == nil, state.tab != .all, let project = project(state.projectId) {
            parts.append(project.name)
        }
        switch state.tab {
        case .today:
            parts.append(clock().formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
            if total > 0 { parts.append(TasksCopy.subtitleDone(counts.done, of: total)) }
        case .tomorrow:
            let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: clock()) ?? clock()
            parts.append(tomorrow.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
            if counts.open > 0 { parts.append(TasksCopy.subtitleTasks(counts.open)) }
        case .next7:
            parts.append(TasksCopy.subtitleTasks(counts.open))
        case .archived:
            parts.append(TasksCopy.subtitleArchived(counts.open))
        case .all:
            if project(state.projectId) != nil, activeSavedFilter == nil, total > 0 {
                parts.append(TasksCopy.subtitleDone(counts.done, of: total))
            } else {
                parts.append(TasksCopy.subtitleTasks(counts.open))
            }
        }
        if showsKanban { parts.append(TasksCopy.subtitleColumns(kanbanEffectiveMode)) }
        if activeSavedFilter == nil, state.filters.isActive { parts.append(TasksCopy.subtitleFiltered) }
        return parts.joined(separator: TasksCopy.subtitleSeparator)
    }
}

/// The large title and its subtitle, drawn as the list's first element.
///
/// iOS 26.5 offers `toolbarTitleMenu` on an inline title only (a large title
/// shows no menu affordance), so the large title is this `Menu`, and the
/// collapsed inline title keeps the system title menu. In select mode it is
/// plain text ("3 selected").
struct TaskListTitleHeader: View {
    let store: TasksStore
    /// Non-nil in select mode: how many rows are selected.
    var selectedCount: Int?
    let openProjects: () -> Void
    let searchProjects: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight / 2) {
            if let selectedCount {
                title(TasksCopy.selectedCount(selectedCount), chevron: false)
            } else {
                Menu {
                    TaskTitleMenu(store: store, openProjects: openProjects, searchProjects: searchProjects)
                } label: {
                    title(store.listTitle, chevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityHint(TasksCopy.titleMenuHint)
                .accessibilityIdentifier("tasks.titleMenu")
            }
            Text(selectedCount.map(TasksCopy.selectDragHint) ?? store.listSubtitle)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityIdentifier("tasks.subtitle")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func title(_ text: String, chevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(text)
                .font(Tokens.Typography.screenTitle.font.weight(.bold))
                .foregroundStyle(Tokens.Text.primary.color)
                .multilineTextAlignment(.leading)
                .accessibilityAddTraits(.isHeader)
            if chevron {
                Image(systemName: "chevron.down")
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(.rect)
    }
}

/// The title menu's content (`toolbarTitleMenu`).
struct TaskTitleMenu: View {
    let store: TasksStore
    let openProjects: () -> Void
    let searchProjects: () -> Void

    var body: some View {
        // Toggles rather than a Picker: a menu row draws no trailing badge,
        // and only a toggle's label keeps the count as its subtitle.
        Section {
            ForEach(TasksTab.allCases) { tab in
                Toggle(isOn: Binding(
                    get: { store.state.tab == tab },
                    set: { on in if on { Task { await store.selectTab(tab) } } }
                )) {
                    Text(TasksCopy.tabTitle(tab))
                    Text("\(store.tabCount(tab))")
                }
                .accessibilityLabel(TasksCopy.tabAccessibility(tab, count: UInt32(store.tabCount(tab))))
                .accessibilityIdentifier("tasks.tab.\(tab.rawValue)")
            }
        }

        Section {
            Menu {
                Picker(TasksCopy.titleMenuProject, selection: projectBinding) {
                    Text(TasksCopy.allProjects).tag(String?.none)
                    ForEach(liveProjects, id: \.id) { project in
                        Text(project.name).tag(Optional(project.id))
                    }
                }
                .pickerStyle(.inline)
                Button(TasksCopy.titleMenuSearchProjects, systemImage: "magnifyingglass", action: searchProjects)
                    .accessibilityIdentifier("tasks.titleMenu.searchProjects")
            } label: {
                Text(TasksCopy.titleMenuProject)
                Text(store.project(store.state.projectId)?.name ?? TasksCopy.allProjects)
            }
            .accessibilityIdentifier("tasks.titleMenu.project")
            ForEach(starred, id: \.id) { filter in
                Button {
                    Task { await store.applyStarredFilter(filter) }
                } label: {
                    Label(
                        filter.name,
                        systemImage: store.activeSavedFilterId == filter.id ? "checkmark" : "star.fill"
                    )
                }
                .accessibilityIdentifier("tasks.titleMenu.savedFilter.\(filter.id)")
            }
        }

        Section {
            Button(TasksCopy.projects, systemImage: "folder", action: openProjects)
                .accessibilityIdentifier("tasks.projectsLink")
        }
    }

    private var liveProjects: [ProjectItem] {
        store.projects.filter { $0.archivedAt == nil }
    }

    private var starred: [SavedFilterItem] {
        store.savedFilters.filter(\.starred)
    }

    private var projectBinding: Binding<String?> {
        Binding(
            get: { store.state.projectId },
            set: { id in Task { await store.selectProject(id) } }
        )
    }
}
