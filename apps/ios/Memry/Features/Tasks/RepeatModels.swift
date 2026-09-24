import Foundation
import MemryCore

// TP045. The repeat sheet's values: the presets, the custom editor's draft,
// the edit a repeating-task dialog applies, and what "Done" leads to. The
// recurrence itself (next dates, series end, completion) is the core's; these
// only build desktop-shaped `RepeatRule` values (D7).

/// What a preset reads off its anchor day (`getRepeatPresets`).
struct RepeatAnchor: Equatable, Sendable {
    /// `YYYY-MM-DD`.
    let key: String
    /// 0 Sunday .. 6 Saturday.
    let weekday: Int64
    let day: Int64
    /// `getWeekOfMonth`: `ceil(day / 7)`.
    let weekOfMonth: Int64
    /// `isLastWeekdayOfMonth`: the same weekday a week later is next month.
    let isLastWeek: Bool

    init?(key: String) {
        guard let date = TaskDates.date(key) else { return nil }
        self.init(date: date)
    }

    /// The local calendar day of `date`.
    init(date: Date) {
        let calendar = Calendar(identifier: .gregorian)
        let day = Int64(calendar.component(.day, from: date))
        let length = Int64(calendar.range(of: .day, in: .month, for: date)?.count ?? 31)
        key = TaskDates.key(date)
        weekday = Int64(calendar.component(.weekday, from: date) - 1)
        self.day = day
        weekOfMonth = (day + 6) / 7
        isLastWeek = day + 7 > length
    }
}

/// One preset row.
struct RepeatPreset: Equatable, Identifiable, Sendable {
    enum Kind: String, CaseIterable, Sendable {
        case daily, weekdays, weekly, biweekly, monthlyDay, monthlyWeek, yearly
    }

    let kind: Kind
    let rule: RepeatRule
    /// The anchor day the preset was built from.
    let anchor: String

    var id: String { kind.rawValue }

    /// Desktop's seven presets for `anchor`.
    static func all(anchor: RepeatAnchor) -> [RepeatPreset] {
        func rule(_ frequency: String, _ interval: Int64) -> RepeatRule {
            RepeatRule(
                frequency: frequency, interval: interval, daysOfWeek: nil, monthlyType: nil,
                dayOfMonth: nil, weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "never",
                endDate: nil, endCount: nil, completedCount: 0, createdAt: nil
            )
        }
        var weekdays = rule("weekly", 1)
        weekdays.daysOfWeek = [1, 2, 3, 4, 5]
        var weekly = rule("weekly", 1)
        weekly.daysOfWeek = [anchor.weekday]
        var biweekly = rule("weekly", 2)
        biweekly.daysOfWeek = [anchor.weekday]
        var monthlyDay = rule("monthly", 1)
        monthlyDay.monthlyType = "dayOfMonth"
        monthlyDay.dayOfMonth = anchor.day
        var monthlyWeek = rule("monthly", 1)
        monthlyWeek.monthlyType = "weekPattern"
        monthlyWeek.weekOfMonth = anchor.isLastWeek ? 5 : anchor.weekOfMonth
        monthlyWeek.dayOfWeekForMonth = anchor.weekday
        let rules: [(Kind, RepeatRule)] = [
            (.daily, rule("daily", 1)), (.weekdays, weekdays), (.weekly, weekly), (.biweekly, biweekly),
            (.monthlyDay, monthlyDay), (.monthlyWeek, monthlyWeek), (.yearly, rule("yearly", 1))
        ]
        return rules.map { RepeatPreset(kind: $0.0, rule: $0.1, anchor: anchor.key) }
    }
}

/// The custom editor's form state (`CustomRepeatDialogInner`).
struct RepeatDraft: Equatable, Sendable {
    var frequency: String
    var interval: Int64
    var daysOfWeek: [Int64]
    var monthlyType: String
    var dayOfMonth: Int64
    var weekOfMonth: Int64
    var dayOfWeekForMonth: Int64
    var endType: String
    var endDate: String?
    var endCount: Int64
    let completedCount: Int64
    let createdAt: String?

    /// From a stored rule, or desktop's default (weekly on the anchor's day).
    init(rule: RepeatRule?, anchor: RepeatAnchor) {
        frequency = rule?.frequency ?? "weekly"
        interval = rule?.interval ?? 1
        daysOfWeek = rule?.daysOfWeek.flatMap { $0.isEmpty ? nil : $0 } ?? [anchor.weekday]
        monthlyType = rule?.monthlyType ?? "dayOfMonth"
        dayOfMonth = rule?.dayOfMonth.flatMap { $0 == 0 ? nil : $0 } ?? anchor.day
        weekOfMonth = rule?.weekOfMonth.flatMap { $0 == 0 ? nil : $0 } ?? anchor.weekOfMonth
        dayOfWeekForMonth = rule?.dayOfWeekForMonth ?? anchor.weekday
        endType = rule?.endType ?? "never"
        endDate = rule?.endDate
        endCount = rule?.endCount.flatMap { $0 == 0 ? nil : $0 } ?? 10
        completedCount = rule?.completedCount ?? 0
        createdAt = rule?.createdAt
    }

    /// Toggles a weekday; the last selected day stays (desktop's rule).
    mutating func toggle(day: Int64) {
        if let index = daysOfWeek.firstIndex(of: day) {
            if daysOfWeek.count > 1 { daysOfWeek.remove(at: index) }
        } else {
            daysOfWeek.append(day)
        }
    }

    /// The rule, carrying only the fields its frequency uses.
    var rule: RepeatRule {
        let monthly = frequency == "monthly"
        return RepeatRule(
            frequency: frequency,
            interval: max(1, interval),
            daysOfWeek: frequency == "weekly" ? daysOfWeek.sorted() : nil,
            monthlyType: monthly ? monthlyType : nil,
            dayOfMonth: monthly && monthlyType == "dayOfMonth" ? dayOfMonth : nil,
            weekOfMonth: monthly && monthlyType == "weekPattern" ? weekOfMonth : nil,
            dayOfWeekForMonth: monthly && monthlyType == "weekPattern" ? dayOfWeekForMonth : nil,
            endType: endType,
            endDate: endType == "date" ? endDate : nil,
            endCount: endType == "count" ? max(1, endCount) : nil,
            completedCount: completedCount,
            createdAt: createdAt
        )
    }
}

/// An edit to a task that is part of a series, held while the Edit Repeating
/// dialog asks how far it reaches.
enum RepeatingEdit: Equatable, Sendable {
    case rule(RepeatRule, repeatFrom: String?)
    case due(date: String?, time: String?)
    case start(date: String?)
}

/// A rule and the anchor it counts from (`due`, `completion`, or unset).
struct RepeatChoice: Equatable, Sendable {
    var rule: RepeatRule?
    var repeatFrom: String?

    /// An anchor only means something beside a rule.
    var normalized: RepeatChoice {
        RepeatChoice(rule: rule, repeatFrom: rule == nil ? nil : repeatFrom)
    }
}

/// What the repeat sheet's "Done" leads to.
enum RepeatSheetOutcome: Equatable, Sendable {
    case unchanged
    /// Hand the rule to the caller (a new task, or a task not yet repeating).
    case commit(RepeatRule?, repeatFrom: String?)
    /// Ask the Stop Repeating question.
    case stopRepeating(taskId: String)
    /// Ask the Edit Repeating question about this edit.
    case editRepeating(taskId: String, edit: RepeatingEdit)

    /// - Parameters:
    ///   - wasRepeating: the task already repeats (its rule may be unreadable).
    ///   - touched: the user picked something in the sheet.
    static func resolve(
        taskId: String?,
        wasRepeating: Bool,
        original: RepeatChoice,
        draft: RepeatChoice,
        touched: Bool
    ) -> RepeatSheetOutcome {
        guard touched else { return .unchanged }
        let next = draft.normalized
        let same = next == original.normalized
        guard let taskId, wasRepeating else {
            return same ? .unchanged : .commit(next.rule, repeatFrom: next.repeatFrom)
        }
        guard let rule = next.rule else { return .stopRepeating(taskId: taskId) }
        return same ? .unchanged : .editRepeating(taskId: taskId, edit: .rule(rule, repeatFrom: next.repeatFrom))
    }
}

/// `RepeatingEdit` as `store.scratch` keeps it between the sheet and the dialog.
struct StoredRepeatingEdit: Codable, Equatable {
    struct Rule: Codable, Equatable {
        var frequency: String
        var interval: Int64
        var daysOfWeek: [Int64]?
        var monthlyType: String?
        var dayOfMonth: Int64?
        var weekOfMonth: Int64?
        var dayOfWeekForMonth: Int64?
        var endType: String
        var endDate: String?
        var endCount: Int64?
        var completedCount: Int64
        var createdAt: String?
    }

    var kind: String
    var rule: Rule?
    var repeatFrom: String?
    var date: String?
    var time: String?

    init(_ edit: RepeatingEdit) {
        switch edit {
        case let .rule(rule, from):
            kind = "rule"
            self.rule = Rule(
                frequency: rule.frequency, interval: rule.interval, daysOfWeek: rule.daysOfWeek,
                monthlyType: rule.monthlyType, dayOfMonth: rule.dayOfMonth, weekOfMonth: rule.weekOfMonth,
                dayOfWeekForMonth: rule.dayOfWeekForMonth, endType: rule.endType, endDate: rule.endDate,
                endCount: rule.endCount, completedCount: rule.completedCount, createdAt: rule.createdAt
            )
            repeatFrom = from
        case let .due(date, time):
            kind = "due"
            self.date = date
            self.time = time
        case let .start(date):
            kind = "start"
            self.date = date
        }
    }

    var edit: RepeatingEdit? {
        switch kind {
        case "rule":
            guard let rule else { return nil }
            return .rule(RepeatRule(
                frequency: rule.frequency, interval: rule.interval, daysOfWeek: rule.daysOfWeek,
                monthlyType: rule.monthlyType, dayOfMonth: rule.dayOfMonth, weekOfMonth: rule.weekOfMonth,
                dayOfWeekForMonth: rule.dayOfWeekForMonth, endType: rule.endType, endDate: rule.endDate,
                endCount: rule.endCount, completedCount: rule.completedCount, createdAt: rule.createdAt
            ), repeatFrom: repeatFrom)
        case "due": return .due(date: date, time: time)
        case "start": return .start(date: date)
        default: return nil
        }
    }
}
