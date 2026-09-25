import MemryCore
import SwiftUI

// IB02 / IB03. The title menu (Paper 02: Inbox, Snoozed & reminders, Archived,
// Insights, with counts) and the filter menu (Paper 03: nine types with
// counts, zero disabled, Clear filter). The view choice and the filter live
// for the app session (00 audit: desktop's per-tab state).

extension InboxStore {
    var viewTitle: String {
        switch view {
        case .inbox: InboxCopy.title
        case .snoozed: InboxCopy.snoozedView
        case .archived: InboxCopy.archivedView
        case .insights: InboxCopy.insightsView
        }
    }

    /// "8 to process · 3 filed today" (Paper 01), per view.
    var viewSubtitle: String {
        switch view {
        case .inbox:
            var parts = [InboxCopy.toProcess(visibleItems.count)]
            parts.append(InboxCopy.filedToday(Int(stats?.processedToday ?? 0)))
            if !typeFilter.isEmpty { parts.append(InboxCopy.filtering(typeFilter.count)) }
            return parts.joined(separator: InboxCopy.subtitleSeparator)
        case .snoozed:
            return InboxCopy.snoozedSubtitle(panel?.upcoming.count ?? 0)
        case .archived:
            return InboxCopy.archivedSubtitle(archivedItems.count)
        case .insights:
            return InboxCopy.insightsSubtitle
        }
    }

    /// The count a view shows in the title menu.
    func menuCount(_ view: InboxView) -> Int? {
        switch view {
        case .inbox: toProcess
        case .snoozed: Int(stats?.snoozedCount ?? 0)
        case .archived, .insights: nil
        }
    }

    static func viewName(_ view: InboxView) -> String {
        switch view {
        case .inbox: InboxCopy.title
        case .snoozed: InboxCopy.snoozedView
        case .archived: InboxCopy.archivedView
        case .insights: InboxCopy.insightsView
        }
    }

    static func viewSymbol(_ view: InboxView) -> String {
        switch view {
        case .inbox: "tray"
        case .snoozed: "moon.zzz"
        case .archived: "archivebox"
        case .insights: "chart.bar"
        }
    }
}

/// The large title, the subtitle and the "N fetching" accessory.
struct InboxTitleHeader: View {
    let store: InboxStore
    var selectedCount: Int?

    var body: some View {
        TitleMenuHeader(
            title: selectedCount.map(InboxCopy.selectedCount) ?? store.viewTitle,
            subtitle: selectedCount == nil ? store.viewSubtitle : InboxCopy.selectHint,
            showsMenu: selectedCount == nil,
            menuHint: InboxCopy.titleMenuHint,
            identifier: "inbox",
            items: { InboxTitleMenu(store: store) },
            leading: { EmptyView() },
            accessory: {
                if selectedCount == nil, store.view == .inbox, let fetching = store.stats?.fetching, fetching > 0 {
                    HStack(spacing: Tokens.Space.tight + 1) {
                        Circle()
                            .fill(Tokens.Inbox.stale.color)
                            .frame(width: Tokens.Space.tight + 2, height: Tokens.Space.tight + 2)
                            .accessibilityHidden(true)
                        Text(InboxCopy.fetching(Int(fetching)))
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Inbox.stale.color)
                    }
                    .accessibilityIdentifier("inbox.fetching")
                }
            }
        )
    }
}

/// Paper 02: the four views, each with its count.
struct InboxTitleMenu: View {
    let store: InboxStore

    var body: some View {
        ForEach(InboxView.allCases) { view in
            Toggle(isOn: Binding(
                get: { store.view == view },
                set: { on in if on { Task { await store.select(view) } } }
            )) {
                Label {
                    Text(InboxStore.viewName(view))
                    if let count = store.menuCount(view) { Text("\(count)") }
                } icon: {
                    Image(systemName: InboxStore.viewSymbol(view))
                }
            }
            .accessibilityIdentifier("inbox.view.\(view.rawValue)")
        }
    }
}

/// Paper 03: filter by type, multi-select, counts, zero disabled.
struct InboxFilterMenu: View {
    let store: InboxStore

    var body: some View {
        Menu {
            Section(InboxCopy.showTypes) {
                ForEach(InboxTypes.all, id: \.self) { type in
                    let count = store.count(of: type)
                    Toggle(isOn: Binding(
                        get: { store.typeFilter.contains(type) },
                        set: { _ in store.toggleType(type) }
                    )) {
                        Label {
                            Text(InboxCopy.typePlural(type))
                            Text("\(count)")
                        } icon: {
                            Image(systemName: InboxTypeGlyph.symbol(type))
                        }
                    }
                    .disabled(count == 0 && !store.typeFilter.contains(type))
                    .accessibilityIdentifier("inbox.filter.\(type)")
                }
            }
            if !store.typeFilter.isEmpty {
                Button(InboxCopy.clearFilter, systemImage: "xmark.circle", role: .destructive) {
                    store.typeFilter = []
                }
                .accessibilityIdentifier("inbox.filter.clear")
            }
        } label: {
            Image(systemName: store.typeFilter.isEmpty
                ? "line.3.horizontal.decrease"
                : "line.3.horizontal.decrease.circle.fill")
                .accessibilityLabel(InboxCopy.filter)
        }
        .menuActionDismissBehavior(.disabled)
        .accessibilityValue(store.typeFilter.isEmpty ? "" : InboxCopy.filtering(store.typeFilter.count))
        .accessibilityIdentifier("inbox.filterButton")
    }
}

/// The capture types in desktop's menu order (`inboxItemType`).
enum InboxTypes {
    static let all = ["link", "note", "image", "voice", "video", "clip", "pdf", "social", "reminder"]
}
