import MemryCore
import SwiftUI

// IB18 / IB19. The title menu's other lists.
//
// Snoozed & reminders (Paper 18, desktop `inbox-reminders-list.tsx`):
// Upcoming (reminders still to fire and snoozed captures) and Past (fired
// reminder captures, viewed or not). A task target opens the task; a snoozed
// capture opens its detail; a fired reminder capture opens its detail, which
// marks it viewed.
//
// Archived (Paper 19): search, day groups, swipe Restore / Delete (asks
// first), tap for the read-only detail.

struct InboxSnoozedView<Header: View>: View {
    let store: InboxStore
    @Binding var titleCollapsed: Bool
    @ViewBuilder let header: () -> Header
    @Environment(InboxRouter.self) private var router
    @Environment(TasksRouter.self) private var tasksRouter

    var body: some View {
        let now = store.clock()
        List {
            Group {
                header().listRowSeparator(.hidden)
                section(InboxCopy.upcoming, store.panel?.upcoming ?? [], now: now, past: false)
                section(InboxCopy.past, store.panel?.past ?? [], now: now, past: true)
                if (store.panel?.upcoming.isEmpty ?? true) && (store.panel?.past.isEmpty ?? true) {
                    Text(InboxCopy.panelEmpty)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .listRowSeparator(.hidden)
                }
                Text(InboxCopy.panelFooter)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .listRowSeparator(.hidden)
            }
            .listRowBackground(Tokens.Canvas.background.color)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await store.sync() }
        .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > Tokens.Size.minimumHitArea }
            action: { _, collapsed in titleCollapsed = collapsed }
        .accessibilityIdentifier("inbox.snoozed")
    }

    @ViewBuilder
    private func section(_ title: String, _ entries: [InboxPanelEntry], now: Date, past: Bool) -> some View {
        if !entries.isEmpty {
            HStack(spacing: Tokens.Space.tight + 2) {
                Text(title).font(Tokens.Typography.caption.font.weight(.semibold))
                Text("\(entries.count)").font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
            }
            .listRowSeparator(.hidden)
            .accessibilityAddTraits(.isHeader)
            ForEach(entries, id: \.key) { entry in
                Button { open(entry) } label: { row(entry, now: now, past: past) }
                    .buttonStyle(.plain)
                    .swipeActions {
                        if let item = entry.item, !past {
                            Button(InboxCopy.unsnooze, systemImage: "tray.and.arrow.down") { Task { await store.unsnooze(item.id) } }
                        }
                    }
                    .accessibilityIdentifier("inbox.panel.\(entry.key)")
            }
        }
    }

    private func row(_ entry: InboxPanelEntry, now: Date, past: Bool) -> some View {
        let isTarget = entry.targetType != nil
        let type = entry.targetType ?? entry.item?.itemType ?? "note"
        let title = isTarget
            ? InboxPanelText.targetTitle(type: type, id: entry.targetId ?? "", title: entry.targetTitle)
            : entry.item.map(InboxMeta.displayTitle) ?? InboxCopy.untitled
        let when = InboxPanelFormat.when(entry.timeMs, now: now)
        let kind = isTarget ? InboxMeta.targetName(type) : InboxCopy.snoozedCapture
        var detail = "\(when) · \(kind)"
        if past { detail += " · " + (entry.item?.viewedAtMs == nil ? InboxCopy.notYetViewed : InboxCopy.viewed) }
        return HStack(alignment: .top, spacing: Tokens.Space.medium) {
            InboxTypeIcon(type: isTarget ? (type == "task" ? "reminder" : type == "journal" ? "reminder" : "note") : type)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Tokens.Typography.body.font).foregroundStyle(Tokens.Text.primary.color)
                Text(detail).font(Tokens.Typography.caption.font)
                    .foregroundStyle(past && entry.item?.viewedAtMs == nil ? Tokens.Inbox.stale.color : Tokens.Text.tertiary.color)
            }
            .padding(.vertical, Tokens.Space.small)
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private func open(_ entry: InboxPanelEntry) {
        if let item = entry.item {
            router.path.append(.item(item.id))
        } else if entry.targetType == "task", let id = entry.targetId {
            tasksRouter.openTask(id)
        } else {
            store.showToast(InboxPanelText.unopenable(entry.targetType ?? "note"))
        }
    }
}

enum InboxPanelFormat {
    /// `reminder.dateTime.*Compact`: "Today, 15:00", "Tomorrow, 09:00", "Mon, 10:00".
    static func when(_ ms: Int64, now: Date, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if calendar.isDate(date, inSameDayAs: now) { return "Today, \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "Tomorrow, \(time)"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let days = abs(calendar.dateComponents([.day], from: now, to: date).day ?? 0)
        return days < 7
            ? "\(date.formatted(.dateTime.weekday(.abbreviated))), \(time)"
            : date.formatted(.dateTime.month(.abbreviated).day())
    }
}

struct InboxArchivedView<Header: View>: View {
    let store: InboxStore
    @Binding var titleCollapsed: Bool
    @ViewBuilder let header: () -> Header
    @Environment(InboxRouter.self) private var router
    @State private var deleting: InboxItemRecord?

    var body: some View {
        @Bindable var store = store
        let now = store.clock()
        let groups = InboxPeriod.group(store.archivedItems.sorted { ($0.archivedAtMs ?? 0) > ($1.archivedAtMs ?? 0) }, now: now)
        List {
            Group {
                header().listRowSeparator(.hidden)
                if groups.isEmpty {
                    Text(store.archivedSearch.isEmpty ? InboxCopy.archivedNone : InboxCopy.archivedNoMatches)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .listRowSeparator(.hidden)
                }
                ForEach(groups, id: \.0) { period, rows in
                    InboxGroupHeader(period: period, count: rows.count).listRowSeparator(.hidden)
                    ForEach(rows, id: \.id) { item in
                        InboxRow(item: item, store: store, now: now)
                            .onTapGesture { router.path.append(.item(item.id)) }
                            .swipeActions(edge: .trailing) {
                                Button(InboxCopy.deleteShort, systemImage: "trash", role: .destructive) { deleting = item }
                                    .accessibilityIdentifier("inbox.archived.delete")
                                Button(InboxCopy.restore, systemImage: "arrow.uturn.backward") {
                                    Task { await store.restore(item) }
                                }
                                .tint(Tokens.Inbox.link.color)
                                .accessibilityIdentifier("inbox.archived.restore")
                            }
                            .accessibilityAction(named: InboxCopy.restore) { Task { await store.restore(item) } }
                            .accessibilityAction(named: InboxCopy.deletePermanently) { deleting = item }
                    }
                }
            }
            .listRowBackground(Tokens.Canvas.background.color)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .searchable(text: $store.archivedSearch, prompt: InboxCopy.searchArchived)
        .onChange(of: store.archivedSearch) { _, _ in Task { await store.refresh() } }
        .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > Tokens.Size.minimumHitArea }
            action: { _, collapsed in titleCollapsed = collapsed }
        .confirmationDialog(InboxCopy.deleteTitle, isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button(InboxCopy.deletePermanently, role: .destructive) {
                if let item = deleting { Task { await store.deletePermanently(item) } }
                deleting = nil
            }
        } message: {
            Text(InboxCopy.deleteBody)
        }
        .accessibilityIdentifier("inbox.archived")
    }
}
