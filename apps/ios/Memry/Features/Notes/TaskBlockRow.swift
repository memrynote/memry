import MemryCore
import SwiftUI

/// A task in a note body, as desktop's row draws it: the status circle, the
/// priority, the title, then the project and the due date.
///
/// The task is the authority once it is here — a tick made on another device
/// shows even if the block's own `checked` prop has not caught up. With no
/// task in this vault the row draws from the block's props alone.
struct TaskBlockRow: View {
    let title: String
    let isChecked: Bool
    let card: TaskCard?

    private var done: Bool { card?.isDone ?? isChecked }
    private var shownTitle: String { card?.title ?? title }

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Space.small) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(done ? Tokens.Text.secondary.color : Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            if let priority = card?.priority, priority > 0 {
                Image(systemName: "cellularbars", variableValue: Double(priority) / 4)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityLabel("Priority \(priority) of 4")
            }
            Text(shownTitle)
                .font(Tokens.Typography.supporting.font.weight(.medium))
                .strikethrough(done, color: Tokens.Text.secondary.color)
                .foregroundStyle(done ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
                .lineLimit(2)
            Spacer(minLength: Tokens.Space.small)
            if let project = card?.projectName, !project.isEmpty {
                Chip(text: project, color: Tokens.Palette.color(card?.projectColor))
            }
            if let due = card?.dueDate.flatMap(Self.dueLabel) {
                Text(due)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? "Done" : "Not done")
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
