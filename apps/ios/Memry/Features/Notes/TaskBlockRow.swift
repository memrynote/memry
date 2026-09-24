import MemryCore
import SwiftUI

/// A task in a note body, as desktop's row draws it: the status circle, the
/// priority, the title, then the project and the due date.
///
/// The task is the authority once it is here — a tick made on another device
/// shows even if the block's own `checked` prop has not caught up. With no
/// task in this vault the row draws from the block's props alone, and offers
/// no controls: desktop hands an unresolved task line none either (#1907),
/// because there is no row behind it to complete or open.
///
/// TP054: the circle completes or reopens the task through the core (which
/// ticks the line in every note holding it), and the title opens the task in
/// the Tasks tab, desktop's "Open in task panel".
struct TaskBlockRow: View {
    let title: String
    let isChecked: Bool
    let card: TaskCard?

    @Environment(\.noteTasks) private var actions

    private var done: Bool { card?.isDone ?? isChecked }
    private var shownTitle: String { card?.title ?? title }
    private var taskId: String? { card?.id }
    private var dueLabel: String? { card?.dueDate.flatMap(Self.dueLabel) }

    private var toggle: (() -> Void)? {
        guard let taskId, let setDone = actions?.setDone else { return nil }
        return { setDone(taskId, !done) }
    }

    private var open: (() -> Void)? {
        guard let taskId, let open = actions?.open else { return nil }
        return { open(taskId) }
    }

    private var isBusy: Bool {
        taskId.map { actions?.isBusy($0) ?? false } ?? false
    }

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Space.small) {
            circle
            if let priority = card?.priority, priority > 0 {
                TaskPriorityIcon(priority: priority)
                    .accessibilityHidden(true)
            }
            titleView
            Spacer(minLength: Tokens.Space.small)
            if let project = card?.projectName, !project.isEmpty {
                Chip(text: project, color: Tokens.Palette.color(card?.projectColor))
                    .accessibilityHidden(true)
            }
            if let dueLabel {
                Text(dueLabel)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityHidden(true)
            }
        }
        // Contained rather than combined, so the circle and the title stay
        // two controls a UI test and Switch Control can reach; the title
        // carries the whole row's sentence and its actions for VoiceOver.
        .accessibilityElement(children: .contain)
        .contextMenu {
            if let toggle {
                Button(action: toggle) {
                    Label(
                        done ? TasksCopy.reopenTask : TasksCopy.completeTask,
                        systemImage: done ? "arrow.uturn.backward.circle" : "checkmark.circle"
                    )
                }
            }
            if let open {
                Button(action: open) {
                    Label(TasksCopy.openInTasks, systemImage: "arrow.up.forward.square")
                }
            }
        }
    }

    @ViewBuilder
    private var circle: some View {
        let icon = Image(systemName: done ? "checkmark.circle.fill" : "circle.dashed")
            .font(Tokens.Typography.body.font)
            .foregroundStyle(done ? Tokens.Task.complete.color : Tokens.Text.tertiary.color)
        if let toggle {
            Button(action: toggle) {
                icon
                    .frame(
                        minWidth: Tokens.Size.minimumHitArea,
                        minHeight: Tokens.Size.minimumHitArea
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
            .sensoryFeedback(.success, trigger: done) { _, isDone in isDone }
            .accessibilityLabel(done ? TasksCopy.reopenTask : TasksCopy.completeTask)
            .accessibilityValue(done ? TasksCopy.taskDone : TasksCopy.taskNotDone)
            .accessibilityIdentifier("tasks.noteBlock.toggle")
        } else {
            icon.accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var titleView: some View {
        let text = Text(shownTitle)
            .font(Tokens.Typography.supporting.font.weight(.medium))
            .strikethrough(done, color: Tokens.Text.secondary.color)
            .foregroundStyle(done ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        if let open {
            Button(action: open) {
                text
                    .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .modifier(TitleAccessibility(row: self))
            .accessibilityIdentifier("tasks.noteBlock.open")
        } else {
            text.modifier(TitleAccessibility(row: self))
        }
    }

    /// The title's VoiceOver reading: the whole row as one sentence, its
    /// state, and the row's actions.
    private struct TitleAccessibility: ViewModifier {
        let row: TaskBlockRow

        func body(content: Content) -> some View {
            content
                .accessibilityLabel(row.accessibilityText)
                .accessibilityValue(row.done ? TasksCopy.taskDone : TasksCopy.taskNotDone)
                .accessibilityHint(row.card == nil ? TasksCopy.taskNotHere : "")
                .accessibilityActions {
                    if let toggle = row.toggle {
                        Button(row.done ? TasksCopy.reopenTask : TasksCopy.completeTask, action: toggle)
                    }
                    if let open = row.open {
                        Button(TasksCopy.openInTasks, action: open)
                    }
                }
        }
    }

    /// Everything the row shows, as one sentence for VoiceOver.
    private var accessibilityText: String {
        var parts = [shownTitle]
        if let priority = card?.priority, priority > 0 {
            parts.append(TasksCopy.blockPriority(priority))
        }
        if let project = card?.projectName, !project.isEmpty {
            parts.append(TasksCopy.blockProject(project))
        }
        if let dueLabel { parts.append(TasksCopy.blockDue(dueLabel)) }
        return parts.joined(separator: ", ")
    }

    /// `Oct 3`, as desktop's row spells a due day. A calendar day, so read
    /// in UTC rather than shifted into the reader's zone.
    static func dueLabel(_ text: String) -> String? {
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM-dd"
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        guard let date = parser.date(from: String(text.prefix(10))) else { return nil }
        var style = Date.FormatStyle().month(.abbreviated).day()
        style.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return date.formatted(style)
    }
}
