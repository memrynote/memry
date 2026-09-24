import MemryCore
import SwiftUI

// TP052. The hub's sections: the overview (desktop's rail: name,
// description, progress, the overview note and pinned notes), the task list
// and the linked notes, files and events.

private typealias Copy = TasksCopy.Projects

struct ProjectHubOverview: View {
    let project: ProjectItem
    let hub: ProjectHubData
    let onChooseHome: () -> Void
    let onClearHome: () -> Void

    var body: some View {
        Section {
            HStack(spacing: Tokens.Space.medium) {
                ProjectIconView(icon: project.icon, color: project.color)
                Text(project.name)
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
            }
            if let description = project.description, !description.isEmpty {
                Text(description)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ProjectProgressView(stats: hub.stats)
            homeNote
            ForEach(hub.pinnedNotes, id: \.id) { link in
                ProjectLinkLabel(link: link, item: hub.titles[link.itemId])
                    .accessibilityHint(Copy.pinned)
            }
        } header: {
            Text(Copy.overviewNote)
        }
    }

    @ViewBuilder private var homeNote: some View {
        if let id = hub.homeNoteId {
            HStack {
                if let item = hub.titles[id] {
                    ProjectRelatedLabel(item: item)
                } else {
                    Label(Copy.itemMissing, systemImage: "questionmark.square.dashed")
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                Spacer(minLength: 0)
                Menu {
                    Button(Copy.chooseOverviewNote, systemImage: "doc.text.magnifyingglass", action: onChooseHome)
                    Button(Copy.clearOverview, systemImage: "xmark", role: .destructive, action: onClearHome)
                        .accessibilityIdentifier("tasks.projectHub.clearHome")
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .accessibilityLabel(Copy.overviewNote)
                .accessibilityIdentifier("tasks.projectHub.homeMenu")
            }
            .accessibilityAction(named: Copy.clearOverview, onClearHome)
        } else {
            Button(action: onChooseHome) {
                Label(Copy.chooseOverviewNote, systemImage: "doc.badge.plus")
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.projectHub.chooseHome")
        }
    }
}

struct ProjectHubTasks: View {
    let store: TasksStore
    let result: TaskViewResult?

    var body: some View {
        let open = rows(result?.taskIds ?? [])
        let done = rows(result?.doneIds ?? [])
        Section(Copy.hubTasks) {
            if open.isEmpty, done.isEmpty {
                Text(Copy.emptyTasks)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ForEach(open, id: \.id) { task in
                TaskRowView(task: task, store: store, depth: task.parentId == nil ? 0 : 1)
            }
        }
        if !done.isEmpty {
            Section(Copy.hubDone) {
                ForEach(done, id: \.id) { task in
                    TaskRowView(task: task, store: store, depth: task.parentId == nil ? 0 : 1)
                }
            }
        }
    }

    private func rows(_ ids: [String]) -> [TaskItem] {
        ids.compactMap { store.items[$0] }
    }
}

struct ProjectHubLinks: View {
    let project: ProjectItem
    let hub: ProjectHubData
    let onAdd: (ProjectLinkPickerMode) -> Void
    let onAction: (ProjectHubLinkAction) -> Void

    var body: some View {
        section(Copy.hubNotes, kind: .note, empty: Copy.emptyNotes, add: .note)
        section(Copy.hubFiles, kind: .file, empty: Copy.emptyFiles, add: .file)
        section(Copy.hubEvents, kind: .event, empty: Copy.emptyEvents, add: nil)
        let other = hub.links(of: .other)
        if !other.isEmpty {
            Section { ForEach(other, id: \.id) { row($0, kind: .other) } }
        }
    }

    private func section(
        _ title: String,
        kind: ProjectLinkKind,
        empty: String,
        add: ProjectLinkPickerMode?
    ) -> some View {
        let links = hub.links(of: kind)
        return Section {
            if links.isEmpty {
                Text(empty)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ForEach(links, id: \.id) { row($0, kind: kind) }
            if let add {
                Button { onAdd(add) } label: {
                    Label(add.title, systemImage: "plus")
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.projectHub.add.\(add.rawValue)")
            }
        } header: {
            Text(title)
        }
    }

    private func row(_ link: ProjectLinkItem, kind: ProjectLinkKind) -> some View {
        ProjectLinkLabel(link: link, item: hub.titles[link.itemId])
            .frame(minHeight: Tokens.Size.minimumHitArea)
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

/// A linked item's title, or what it is when this device cannot name it.
struct ProjectLinkLabel: View {
    let link: ProjectLinkItem
    let item: RelatedItemRecord?

    var body: some View {
        HStack {
            if let item {
                ProjectRelatedLabel(item: item)
            } else if ProjectLinkKind(itemType: link.itemType) == .event {
                Label(Copy.calendarEvent, systemImage: "calendar")
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                Label(Copy.itemMissing, systemImage: "questionmark.square.dashed")
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
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
}
