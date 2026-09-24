import MemryCore
import SwiftUI

// TP045. What survives of the Repeat sheet now that repeat is edited on the
// When sheet's Repeat page (`TaskWhenRepeatPage`, RD11): the "current repeat"
// section shown there for a task that already repeats, the host for the Stop
// Repeating / Edit Repeating dialogs, and the repeat text helpers.
// **Done decides, the dialogs write**: the When sheet raises the question once
// it has gone (`TaskWhenCommit`), and the answer writes.

/// The rule the task has now: what it reads as, its settings line and,
/// for a count-limited series, how far it has run.
struct RepeatCurrentSection: View {
    let rule: RepeatRule?
    let repeatFrom: String?

    var body: some View {
        Section(TasksCopy.currentRepeat) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Label(rule.map(TasksCopy.repeatSummary) ?? TasksCopy.repeats, systemImage: "repeat")
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                if let rule {
                    Text(TasksCopy.repeatInfoLine(rule, repeatFrom: repeatFrom))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    if rule.endType == "count", let total = rule.endCount, total > 0 {
                        Text(TasksCopy.repeatProgress(done: rule.completedCount, total: total))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Task.repeatMark.color)
                            .accessibilityIdentifier("tasks.repeat.progress")
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tasks.repeat.current")
        }
    }
}

extension View {
    /// TP045 — hosts the Stop Repeating / Edit Repeating dialogs the store raises.
    func repeatPrompts(store: TasksStore) -> some View {
        modifier(RepeatPromptsHost(store: store))
    }
}

/// How a task's repeat reads in the row (desktop `TaskRepeatSection`'s title
/// and info line), from the stored rule's fields only.
enum TaskRepeatText {
    static func summary(_ task: TaskItem) -> String {
        guard task.isRepeating else { return TasksCopy.Detail.noRepeat }
        guard let rule = task.repeat else { return TasksCopy.Detail.repeatsUnreadable }
        return TasksCopy.Detail.repeatSummary(frequency: rule.frequency, interval: rule.interval)
    }

    /// `Ends: … | Done: Nx`, or `nil` without a readable rule.
    static func info(_ rule: RepeatRule?) -> String? {
        guard let rule else { return nil }
        var parts: [String] = []
        switch rule.endType {
        case "date":
            if let end = rule.endDate, let date = TaskDates.date(end) {
                parts.append(TasksCopy.Detail.repeatEndsOn(date.formatted(.dateTime.month(.abbreviated).day())))
            }
        case "count":
            if let count = rule.endCount { parts.append(TasksCopy.Detail.repeatEndsAfter(count)) }
        default:
            parts.append(TasksCopy.Detail.repeatEndsNever)
        }
        parts.append(TasksCopy.Detail.repeatDoneCount(rule.completedCount))
        return parts.joined(separator: " | ")
    }
}
