import MemryCore
import SwiftUI

// TP052, redesigned (RD18, Paper "Project hub"). The hub's sections: the
// header (progress ring, name, "7 of 12 done · 1 overdue", description, the
// overview note card), the project's tasks (rows without the project name,
// the done ones folded), and one "Linked" list of notes, files and events
// (only when there are any). Linking, the overview note and the project
// actions live in the "…" menu.

private typealias Copy = TasksCopy.Projects

/// Ring + title, progress, description and the overview note card.
struct ProjectHubHeader: View {
    let project: ProjectItem
    let hub: ProjectHubData
    let onChooseHome: () -> Void
    let onClearHome: () -> Void

    private var total: Int { Int(hub.stats?.taskCount ?? 0) }
    private var done: Int { Int(hub.stats?.completedCount ?? 0) }
    private var overdue: Int { Int(hub.stats?.overdueCount ?? 0) }

    /// Paper's 28pt hub title: the detail's document title role.
    static var titleFont: Font { TypeRole(.documentTitle, weight: .bold).font }

    /// Title text starts after the ring lane (Paper: subtitle under the name).
    static var textLeading: CGFloat { TaskLayout.lane + Tokens.Space.medium }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
                Text(verbatim: "A")
                    .font(Self.titleFont)
                    .hidden()
                    .frame(width: TaskLayout.lane)
                    .overlay {
                        TaskProgressRing(
                            fraction: total == 0 ? 0 : Double(done) / Double(total),
                            color: Tokens.Palette.color(project.color),
                            font: Tokens.Typography.sectionTitle.font
                        )
                    }
                Text(title)
                    .font(Self.titleFont)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                // Nothing to count yet: the tasks section says so instead.
                if total > 0 {
                    HStack(spacing: Tokens.Space.small) {
                        Text(Copy.doneOf(done: done, total: total))
                            .foregroundStyle(Tokens.Text.tertiary.color)
                        if overdue > 0 {
                            Text(Copy.overdueCount(overdue))
                                .foregroundStyle(Tokens.Task.dueOverdue.color)
                        }
                    }
                    .font(Tokens.Typography.supporting.font)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("tasks.projectProgress")
                }
                if let description = project.description, !description.isEmpty {
                    Text(description)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                if hub.homeNoteId != nil { homeCard }
            }
            .padding(.leading, Self.textLeading)
        }
        .padding(.bottom, Tokens.Space.small)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(
            top: Tokens.Space.small, leading: TaskLayout.edge, bottom: Tokens.Space.small, trailing: TaskLayout.edge
        ))
    }

    /// The name, after the project's emoji when it has one.
    private var title: String {
        ProjectIconValue.emoji(project.icon).map { "\($0) \(project.name)" } ?? project.name
    }

    /// Paper's overview card: the note's title and "Overview"; a tap offers
    /// another note or clearing it.
    private var homeCard: some View {
        Menu {
            Button(Copy.chooseOverviewNote, systemImage: "doc.text.magnifyingglass", action: onChooseHome)
            Button(Copy.clearOverview, systemImage: "xmark", role: .destructive, action: onClearHome)
                .accessibilityIdentifier("tasks.projectHub.clearHome")
        } label: {
            HStack(spacing: Tokens.Space.medium) {
                Image(systemName: "doc.text")
                    .foregroundStyle(Tokens.Task.tokenNote.color)
                    .accessibilityHidden(true)
                Text(homeTitle)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(1)
                Spacer(minLength: Tokens.Space.small)
                Text(Copy.overviewNote)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.top, Tokens.Space.small)
        .accessibilityLabel("\(Copy.overviewNote): \(homeTitle)")
        .accessibilityAction(named: Copy.clearOverview, onClearHome)
        .accessibilityIdentifier("tasks.projectHub.homeMenu")
    }

    private var homeTitle: String {
        guard let id = hub.homeNoteId else { return "" }
        guard let item = hub.titles[id] else { return Copy.itemMissing }
        return item.title.isEmpty ? Copy.untitled : item.title
    }
}

/// "Tasks N open", the rows, then the done ones folded under "Completed N".
struct ProjectHubTasks: View {
    let store: TasksStore
    let result: TaskViewResult?
    @Binding var showsDone: Bool

    var body: some View {
        let open = rows(result?.taskIds ?? [])
        let done = rows(result?.doneIds ?? [])
        let topOpen = open.filter { $0.depth == 0 }.count
        if open.isEmpty, done.isEmpty {
            Text(Copy.emptyTasks)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge))
        } else {
            ProjectHubSectionHeader(title: Copy.hubTasks, detail: Copy.openCount(topOpen))
        }
        ForEach(open, id: \.task.id) { row($0) }
        if !done.isEmpty {
            Button {
                showsDone.toggle()
            } label: {
                ProjectHubSectionHeader(
                    title: TasksCopy.completedGroup,
                    detail: "\(done.filter { $0.depth == 0 }.count)",
                    folded: !showsDone
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("tasks.projectHub.done")
            if showsDone {
                ForEach(done, id: \.task.id) { row($0) }
            }
        }
    }

    private func row(_ entry: HubRow) -> some View {
        TaskRowView(
            task: entry.task,
            store: store,
            depth: entry.depth,
            context: TaskMeta.Context(showsProject: false)
        )
    }

    struct HubRow {
        let task: TaskItem
        let depth: Int
    }

    /// Each top-level task followed by its own subtasks (the core's order
    /// within each), so a subtask never sits under the wrong parent.
    private func rows(_ ids: [String]) -> [HubRow] {
        let items = ids.compactMap { store.items[$0] }
        let present = Set(items.map(\.id))
        let isChild: (TaskItem) -> Bool = { task in task.parentId.map(present.contains) ?? false }
        let children = Dictionary(grouping: items.filter(isChild)) { $0.parentId ?? "" }
        return items.filter { !isChild($0) }.flatMap { top in
            [HubRow(task: top, depth: 0)] + (children[top.id] ?? []).map { HubRow(task: $0, depth: 1) }
        }
    }
}

/// A small section title with its count ("Tasks 5 open", "Linked 3").
struct ProjectHubSectionHeader: View {
    let title: String
    let detail: String
    var folded: Bool?

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            if let folded {
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .rotationEffect(.degrees(folded ? 0 : 90))
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
            Text(detail)
                .font(Tokens.Typography.caption.font.monospacedDigit())
                .foregroundStyle(Tokens.Text.tertiary.color)
            Spacer(minLength: 0)
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: Tokens.Space.small, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge))
        .moveDisabled(true)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One "Linked N" list of notes, files and events, pinned notes first.
struct ProjectHubLinks: View {
    let hub: ProjectHubData
    let onAction: (ProjectHubLinkAction) -> Void

    var body: some View {
        let links = hub.links.sorted { $0.pinned && !$1.pinned }
        if !links.isEmpty {
            ProjectHubSectionHeader(title: TasksCopy.Detail.linked, detail: "\(links.count)")
            ForEach(links, id: \.id) { row($0) }
        }
    }

    private func row(_ link: ProjectLinkItem) -> some View {
        let kind = ProjectLinkKind(itemType: link.itemType)
        return ProjectLinkLabel(link: link, item: hub.titles[link.itemId])
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .listRowInsets(EdgeInsets(top: 0, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge))
            .alignmentGuide(.listRowSeparatorLeading) { _ in ProjectHubHeader.textLeading }
            .accessibilityIdentifier("tasks.projectHub.link.\(link.itemId)")
            .swipeActions(edge: .trailing) {
                Button(Copy.unlink, systemImage: "link.badge.minus", role: .destructive) {
                    onAction(.unlink(link))
                }
            }
            .swipeActions(edge: .leading) {
                if kind == .note { pinButton(link) }
            }
            .contextMenu {
                if kind == .note { pinButton(link) }
                Button(Copy.unlink, systemImage: "link.badge.minus", role: .destructive) {
                    onAction(.unlink(link))
                }
            }
            .accessibilityActions {
                if kind == .note { pinButton(link) }
                Button(Copy.unlink) { onAction(.unlink(link)) }
            }
    }

    private func pinButton(_ link: ProjectLinkItem) -> some View {
        Button(link.pinned ? Copy.unpin : Copy.pin, systemImage: link.pinned ? "pin.slash" : "pin") {
            onAction(.pin(link, !link.pinned))
        }
    }
}

/// A linked item: a kind icon in the lane and its title (Paper: title only),
/// or what it is when this device cannot name it; a pin when pinned.
struct ProjectLinkLabel: View {
    let link: ProjectLinkItem
    let item: RelatedItemRecord?

    private var kind: ProjectLinkKind { ProjectLinkKind(itemType: link.itemType) }

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Group {
                if let emoji = item?.emoji, !emoji.isEmpty {
                    Text(emoji)
                } else {
                    Image(systemName: symbol).foregroundStyle(tint)
                }
            }
            .font(Tokens.Typography.body.font)
            .frame(width: TaskLayout.lane)
            .accessibilityHidden(true)
            Text(title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(item == nil ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .lineLimit(2)
            Spacer(minLength: 0)
            if link.pinned {
                Image(systemName: "pin.fill")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(Copy.pinned)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        if let item { return item.title.isEmpty ? Copy.untitled : item.title }
        return kind == .event ? Copy.calendarEvent : Copy.itemMissing
    }

    private var symbol: String {
        switch kind {
        case .note: "doc.text"
        case .file: "doc"
        case .event: "calendar"
        case .other: "questionmark.square.dashed"
        }
    }

    private var tint: Color {
        switch kind {
        case .note: Tokens.Task.tokenNote.color
        case .event: Tokens.Task.dueUpcoming.color
        case .file, .other: Tokens.Text.tertiary.color
        }
    }
}
