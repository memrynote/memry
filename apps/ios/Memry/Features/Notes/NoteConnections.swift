import MemryCore
import SwiftUI

// What a note is connected to, under its body: the notes and days linking
// here (N800), its linked tasks (N807) and its reminders (N804) as one card
// with a group each, then the unlinked mentions line. A group with nothing in
// it is not drawn, and neither is the card when every group is empty.

struct NoteConnections: View {
    /// `nil` where the page draws no backlinks: the inspector shows them, or
    /// the page has nowhere to open them.
    let backlinks: BacklinksViewModel?
    let linkedTasks: LinkedTasksViewModel
    /// `nil` on a journal day, whose reminders live on the bell.
    let reminders: NoteRemindersViewModel?
    /// `nil` on a page that cannot edit other notes.
    let unlinkedMentions: UnlinkedMentionsViewModel?
    /// The note's title, which is what a mention's Link targets.
    let targetTitle: String
    let open: ((NoteRoute) -> Void)?
    /// Opens a task by id. `nil` draws the task rows without the action.
    let openTask: ((String) -> Void)?

    @Environment(\.vaultSearchIndex) private var searchIndex

    private enum Group: Hashable {
        case backlinks, tasks, reminders
    }

    private var groups: [Group] {
        var groups: [Group] = []
        if let backlinks, open != nil {
            switch backlinks.phase {
            case .loading: break
            case let .ready(rows): if !rows.isEmpty { groups.append(.backlinks) }
            case .failed: groups.append(.backlinks)
            }
        }
        if !linkedTasks.tasks.isEmpty { groups.append(.tasks) }
        if let reminders, !reminders.live.isEmpty { groups.append(.reminders) }
        return groups
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if !groups.isEmpty { card }
            if let unlinkedMentions, let open {
                UnlinkedMentionsSection(model: unlinkedMentions, targetTitle: targetTitle, open: open)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await linkedTasks.load() }
        .task { await reminders?.load() }
        .task(id: searchIndex?.completed) { await backlinks?.reload() }
        .modifier(NoteReminderAddSheet(model: reminders))
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element) { index, group in
                if index > 0 {
                    Rectangle()
                        .fill(Tokens.Line.border.color)
                        .frame(height: Tokens.Size.hairline)
                }
                self.group(group)
                    .padding(.horizontal, Tokens.Space.medium)
                    .padding(.vertical, Tokens.Space.tight)
            }
        }
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
    }

    @ViewBuilder
    private func group(_ group: Group) -> some View {
        switch group {
        case .backlinks:
            if let backlinks, let open { backlinksGroup(backlinks, open: open) }
        case .tasks:
            ConnectionGroupLabel(title: TasksCopy.linkedTasksTitle, count: linkedTasks.tasks.count)
            ForEach(linkedTasks.tasks, id: \.id) { task in
                LinkedTaskRow(task: task, open: openTask)
            }
        case .reminders:
            if let reminders {
                ConnectionGroupLabel(title: "Reminders", count: reminders.live.count)
                ForEach(reminders.live, id: \.id) { reminder in
                    NoteReminderRow(model: reminders, reminder: reminder)
                }
            }
        }
    }

    @ViewBuilder
    private func backlinksGroup(_ model: BacklinksViewModel, open: @escaping (NoteRoute) -> Void) -> some View {
        switch model.phase {
        case .loading:
            EmptyView()
        case let .ready(rows):
            ConnectionGroupLabel(title: "Linked from", count: rows.count) {
                BacklinkOrderPicker(model: model)
            }
            ForEach(rows) { BacklinkRowButton(backlink: $0, open: open) }
        case let .failed(error):
            ConnectionGroupLabel(title: "Linked from", count: nil)
            ErrorNotice(error: error, code: nil)
        }
    }
}

/// A group's heading in the connections card: its name, its count, and an
/// optional control at the trailing edge.
struct ConnectionGroupLabel<Trailing: View>: View {
    let title: String
    let count: Int?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            Text(title)
                .fontWeight(.semibold)
                .foregroundStyle(Tokens.Text.secondary.color)
            if let count {
                Text("\(count)")
                    .monospacedDigit()
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            Spacer(minLength: Tokens.Space.small)
            trailing()
        }
        .font(Tokens.Typography.caption.font)
        .padding(.top, Tokens.Space.small)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }
}

extension ConnectionGroupLabel where Trailing == EmptyView {
    init(title: String, count: Int?) {
        self.init(title: title, count: count) { EmptyView() }
    }
}

/// One row of the connections card: a kind's symbol in its colour, the title,
/// and a line under it saying more.
struct ConnectionRow: View {
    let symbol: String
    let tint: Color
    let title: String
    var detail: String?
    var isDone = false

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: Tokens.Space.section)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(isDone ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
                    .strikethrough(isDone)
                    .lineLimit(2)
                if let detail {
                    Text(detail)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
    }
}
