import MemryCore
import SwiftUI

// TP040. The chrome above the task list, after desktop's `tasks-tab-bar.tsx`
// and the view-mode switch in `pages/tasks.tsx`: the five scopes with their
// counts, the project scope, and List/Kanban on the All tab.

/// The scope tabs, the project scope button and the view-mode switch.
struct TaskListHeader: View {
    let store: TasksStore
    @Binding var showsScopePicker: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            TaskListTabs(store: store)
            HStack(spacing: Tokens.Space.small) {
                scopeButton
                Spacer(minLength: 0)
                if store.state.tab == .all {
                    viewModePicker
                }
            }
            .padding(.horizontal, Tokens.Space.inset)
        }
        .padding(.vertical, Tokens.Space.small)
    }

    private var scopeTitle: String {
        if let id = store.activeSavedFilterId, let filter = store.savedFilters.first(where: { $0.id == id }) {
            return filter.name
        }
        return store.project(store.state.projectId)?.name ?? TasksCopy.allProjects
    }

    private var scopeButton: some View {
        Button {
            showsScopePicker = true
        } label: {
            HStack(spacing: Tokens.Space.tight) {
                Image(systemName: store.activeSavedFilterId == nil ? "folder" : "star.fill")
                    .accessibilityHidden(true)
                Text(scopeTitle).lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(Tokens.Typography.caption.font)
                    .accessibilityHidden(true)
            }
            .font(Tokens.Typography.label.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.control))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(TasksCopy.projectScope): \(scopeTitle)")
        .accessibilityIdentifier("tasks.scopePicker")
    }

    private var viewModePicker: some View {
        Picker(TasksCopy.viewModeLabel, selection: Binding(
            get: { store.state.viewMode },
            set: { store.setViewMode($0) }
        )) {
            Image(systemName: "list.bullet")
                .accessibilityLabel(TasksCopy.listView)
                .tag(TasksViewMode.list)
            Image(systemName: "rectangle.split.3x1")
                .accessibilityLabel(TasksCopy.kanbanView)
                .tag(TasksViewMode.kanban)
        }
        .pickerStyle(.segmented)
        .fixedSize()
        .accessibilityIdentifier("tasks.viewMode")
    }
}

/// All / Today / Tomorrow / Next 7 days / Archived, each with its count.
///
/// A scrolling row of segments rather than a system segmented control: five
/// labels with counts do not fit one at larger Dynamic Type sizes.
struct TaskListTabs: View {
    let store: TasksStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Tokens.Space.tight) {
                ForEach(TasksTab.allCases) { tab in
                    segment(tab)
                }
            }
            .padding(.horizontal, Tokens.Space.inset)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TasksCopy.tabsLabel)
    }

    private func count(_ tab: TasksTab) -> UInt32 {
        guard let counts = store.result?.counts else { return 0 }
        switch tab {
        case .all: return counts.all
        case .today: return counts.today
        case .tomorrow: return counts.tomorrow
        case .next7: return counts.next7
        case .archived: return counts.archived
        }
    }

    private func segment(_ tab: TasksTab) -> some View {
        let selected = store.state.tab == tab
        let count = count(tab)
        return Button {
            Task { await store.selectTab(tab) }
        } label: {
            HStack(spacing: Tokens.Space.tight) {
                Text(TasksCopy.tabTitle(tab))
                if count > 0 {
                    Text("\(count)")
                        .font(Tokens.Typography.caption.font.monospacedDigit())
                        .foregroundStyle(selected ? Tokens.Text.primary.color : Tokens.Text.tertiary.color)
                }
            }
            .font(Tokens.Typography.label.font)
            .foregroundStyle(selected ? Tokens.Text.primary.color : Tokens.Text.secondary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(
                selected ? Tokens.Canvas.surfaceActive.color : Color.clear,
                in: .rect(cornerRadius: Tokens.Radius.control)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.tabAccessibility(tab, count: count))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("tasks.tab.\(tab.rawValue)")
    }
}
