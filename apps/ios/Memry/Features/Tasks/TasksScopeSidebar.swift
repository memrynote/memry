import MemryCore
import SwiftUI

// #4350. The Tasks split view's sidebar: what the title menu and the scope
// sheet hold at compact width, laid out as a column. The views with their
// counts, the project scope, the starred saved filters, and the way to the
// projects list. A view and a project are picked independently, as on
// desktop's tab strip and project picker, so each section marks its own pick.
// A pick returns the list column to the list.

struct TasksScopeSidebar: View {
    let store: TasksStore
    @Environment(TasksRouter.self) private var router

    var body: some View {
        List {
            Section {
                ForEach(TasksTab.allCases) { tab in
                    row(
                        TasksCopy.tabTitle(tab),
                        symbol: Self.symbol(tab),
                        count: store.tabCount(tab),
                        selected: store.state.tab == tab,
                        identifier: "tasks.sidebar.tab.\(tab.rawValue)"
                    ) { await store.selectTab(tab) }
                    .accessibilityLabel(TasksCopy.tabAccessibility(tab, count: UInt32(store.tabCount(tab))))
                }
            }
            Section(TasksCopy.projects) {
                row(
                    TasksCopy.allProjects,
                    symbol: "folder",
                    selected: store.state.projectId == nil && store.activeSavedFilterId == nil,
                    identifier: "tasks.sidebar.project.all"
                ) { await store.selectProject(nil) }
                ForEach(store.projects.filter { $0.archivedAt == nil }, id: \.id) { project in
                    row(
                        project.name,
                        color: project.color,
                        selected: store.state.projectId == project.id,
                        identifier: "tasks.sidebar.project.\(project.id)"
                    ) { await store.selectProject(project.id) }
                }
                Button {
                    router.listPath = [.projects]
                } label: {
                    Label(TasksCopy.manageProjects, systemImage: "ellipsis.circle")
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                .accessibilityIdentifier("tasks.sidebar.projects")
            }
            let starred = store.savedFilters.filter(\.starred)
            if !starred.isEmpty {
                Section(TasksCopy.starredFilters) {
                    ForEach(starred, id: \.id) { filter in
                        row(
                            filter.name,
                            symbol: "star.fill",
                            selected: store.activeSavedFilterId == filter.id,
                            identifier: "tasks.sidebar.savedFilter.\(filter.id)"
                        ) { await store.applyStarredFilter(filter) }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle(VaultTab.tasks.title)
        .accessibilityIdentifier("tasks.sidebar")
    }

    private func row(
        _ title: String,
        symbol: String? = nil,
        color: String? = nil,
        count: Int? = nil,
        selected: Bool,
        identifier: String,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        Button {
            router.listPath = []
            Task { await action() }
        } label: {
            Label {
                HStack {
                    Text(title).foregroundStyle(Tokens.Text.primary.color)
                    Spacer(minLength: Tokens.Space.small)
                    if let count {
                        Text("\(count)")
                            .monospacedDigit()
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
            } icon: {
                if let symbol {
                    Image(systemName: symbol).foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    TaskProjectDot(color: color, font: Tokens.Typography.body.font)
                }
            }
        }
        .listRowBackground(selected ? Tokens.Canvas.surfaceActive.color : nil)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier)
    }

    private static func symbol(_ tab: TasksTab) -> String {
        switch tab {
        case .all: "tray.full"
        case .today: "sun.max"
        case .tomorrow: "sunrise"
        case .next7: "calendar"
        case .archived: "archivebox"
        }
    }
}

extension TasksCopy {
    static let manageProjects = "Manage projects"
}
