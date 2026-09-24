import Foundation
import MemryCore

// TP044 / TP045. The date sheet's and the repeat sheet's words, mirroring
// desktop's `tasks.json` (`phaseF.componentsTasksDueDatePicker`,
// `…NaturalDateInput`, `…DatePickerContent`, `…RepeatPicker`,
// `…CustomRepeatDialog`, `…StopRepeatingDialog`, `…EditRepeatingTaskDialog`,
// `…TaskRepeatSection`, `…RepeatIndicator`) and `common.json` `recurrence.*`.
// English only (D1).

extension TasksCopy {
    // MARK: Date sheet

    static let dueDateTitle = "Due date"
    static let startDateTitle = "Start date"
    static let dateSuggestions = "Suggestions"
    static let dateToday = "Today"
    static let dateTomorrow = "Tomorrow"
    static let dateThisWeekend = "This Weekend"
    static let dateNextWeek = "Next Week"
    static let naturalDatePlaceholder = "Type a date... \"next friday\", \"dec 25\""
    static let naturalDateLabel = "Type a date in natural language"
    static let naturalDateSelect = "Select"
    static let naturalDateNotUnderstood = "Couldn't understand this date"
    static let pickADate = "Pick a date"
    static let calendarToday = "Today"
    static let calendarTodayHint = "Selects today in the calendar"
    static let addTime = "Add time"
    static let time = "Time"
    static let clearTime = "Clear time"
    static let removeDate = "Remove date"
    static let noDate = "No date"
    static let dateDone = "Done"
    static let dateCancel = "Cancel"

    static func acceptDateCompletion(_ phrase: String) -> String { "Complete to \(phrase)" }

    static func suggestionLabel(_ kind: TaskDateSuggestion.Kind) -> String {
        switch kind {
        case .today: dateToday
        case .tomorrow: dateTomorrow
        case .weekend: dateThisWeekend
        case .nextWeek: dateNextWeek
        }
    }

    // MARK: Repeat sheet

    static let repeatTitle = "Repeat"
    static let doesNotRepeat = "Does not repeat"
    static let customRepeatRow = "Custom..."
    static let customRepeatTitle = "Custom Repeat"
    static let currentRepeat = "Current"
    static let repeatFromTitle = "Repeat from"
    static let repeatFromDue = "Due date"
    static let repeatFromCompletion = "Completion date"
    static let repeatSave = "Save"
    static let repeatDone = "Done"
    static let repeatCancel = "Cancel"
    static let repeatFrequency = "Frequency"
    static let repeatEvery = "Repeat every"
    static let repeatOnTheseDays = "On these days"
    static let repeatOn = "Repeat on"
    static let repeatMonthDay = "Day"
    static let repeatOfTheMonth = "of the month"
    static let repeatMonthThe = "The"
    static let repeatEnds = "Ends"
    static let repeatEndsNever = "Never"
    static let repeatEndsOnDate = "On date"
    static let repeatEndsAfter = "After"
    static let repeatOccurrences = "occurrences"
    static let repeatPreview = "Preview"
    static let repeatAndMore = "… and more"
    /// `recurrence.repeats`: a stored rule this build cannot read.
    static let repeats = "Repeats"

    static func repeatUnit(_ frequency: String, interval: Int64) -> String {
        let unit = switch frequency {
        case "daily": "day"
        case "weekly": "week"
        case "monthly": "month"
        default: "year"
        }
        return interval > 1 ? "\(unit)s" : unit
    }

    static func repeatPreviewHeader(_ rule: RepeatRule) -> String {
        if rule.endType == "count", let count = rule.endCount, count > 0 {
            return "\(count) occurrences:"
        }
        if rule.endType == "date", let end = rule.endDate {
            return "Occurrences until \(shortDate(end)):"
        }
        return "Next occurrences:"
    }

    /// `(1 of 10)` beside a preview date of a count-limited series.
    static func repeatPreviewIndex(_ index: Int, of total: Int64) -> String { "(\(index) of \(total))" }

    /// The repeat indicator's tooltip line (`getRepeatProgress`).
    static func repeatProgress(done: Int64, total: Int64) -> String { "\(done) of \(total) completed" }

    /// `buildRepeatInfoLine` (`task-repeat-section.tsx`).
    static func repeatInfoLine(_ rule: RepeatRule, repeatFrom: String?) -> String {
        var parts = ["From: \(repeatFrom == "completion" ? repeatFromCompletion : repeatFromDue)"]
        if rule.endType == "never" {
            parts.append("Ends: Never")
        } else if rule.endType == "date", let end = rule.endDate {
            parts.append("Ends: \(shortDate(end))")
        } else if rule.endType == "count", let count = rule.endCount, count > 0 {
            parts.append("Ends: After \(count)x")
        }
        parts.append("Done: \(rule.completedCount)x")
        return parts.joined(separator: " | ")
    }

    static func repeatWeekdayToggle(_ day: Int, selected: Bool) -> String {
        selected ? "\(dayNames[day]), selected" : dayNames[day]
    }

    // MARK: Recurrence labels (`getRepeatDisplayText`, `recurrence.*`)

    /// `DAY_NAMES`, Sunday first as the rule indexes them.
    static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static let shortDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    /// `ORDINALS`: index 1...4, 5 = last.
    static let ordinals = ["", "first", "second", "third", "fourth", "last"]

    static func ordinal(_ week: Int64) -> String {
        ordinals.indices.contains(Int(week)) ? ordinals[Int(week)] : ""
    }

    static func dayName(_ day: Int64) -> String {
        dayNames.indices.contains(Int(day)) ? dayNames[Int(day)] : ""
    }

    /// English `getOrdinalSuffix`.
    static func ordinalSuffix(_ number: Int64) -> String {
        if (11 ... 13).contains(number % 100) { return "th" }
        switch number % 10 {
        case 1: return "st"
        case 2: return "nd"
        case 3: return "rd"
        default: return "th"
        }
    }

    static let everyWeekdayPreset = "Every weekday (Mon-Fri)"

    static func everyYearOnDate(_ monthDay: String) -> String { "Every year on \(monthDay)" }

    /// What a rule reads as, word for word desktop's `getRepeatDisplayText`.
    static func repeatSummary(_ rule: RepeatRule) -> String {
        let count = rule.interval
        let every = count == 1 ? "Every" : "Every \(count)"
        switch rule.frequency {
        case "daily":
            return count == 1 ? "Every day" : "\(every) days"
        case "weekly":
            return weeklySummary(rule, every: every)
        case "monthly":
            if rule.monthlyType == "dayOfMonth", let day = rule.dayOfMonth, day != 0 {
                let unit = count == 1 ? "month" : "months"
                return "\(every) \(unit) on the \(day)\(ordinalSuffix(day))"
            }
            if rule.monthlyType == "weekPattern", let week = rule.weekOfMonth, week != 0,
               let weekday = rule.dayOfWeekForMonth {
                let unit = count == 1 ? "month" : "months"
                return "\(every) \(unit) on the \(ordinal(week)) \(dayName(weekday))"
            }
            return count == 1 ? "Every month" : "\(every) months"
        case "yearly":
            return count == 1 ? "Every year" : "\(every) years"
        default:
            return repeats
        }
    }

    private static func weeklySummary(_ rule: RepeatRule, every: String) -> String {
        let count = rule.interval
        let unit = count == 1 ? "week" : "weeks"
        guard let days = rule.daysOfWeek, !days.isEmpty else { return "\(every) \(unit)" }
        if days.count == 5, [1, 2, 3, 4, 5].allSatisfy(days.contains) {
            return count == 1 ? "Every weekday" : "\(every) weeks on weekdays"
        }
        if days.count == 2, days.contains(0), days.contains(6) {
            return count == 1 ? "Every weekend" : "\(every) weeks on weekends"
        }
        let names = days.sorted().map { day in
            let names = days.count > 2 ? shortDayNames : dayNames
            return names.indices.contains(Int(day)) ? names[Int(day)] : ""
        }
        return "\(every) \(unit) on \(names.joined(separator: ", "))"
    }

    /// A preset's label (`getRepeatPresets`).
    static func repeatPresetLabel(_ preset: RepeatPreset) -> String {
        switch preset.kind {
        case .weekdays: everyWeekdayPreset
        case .yearly: everyYearOnDate(monthDay(preset.anchor))
        default: repeatSummary(preset.rule)
        }
    }

    // MARK: Stop / edit repeating dialogs

    static let stopRepeatingTitle = "Stop Repeating"
    static let stopRepeatingKeep = "Keep this task, stop future occurrences"
    static let stopRepeatingDelete = "Delete this and all future occurrences"
    static let stopRepeatingAction = "Stop repeating"

    static func stopRepeatingMessage(title: String, rule: RepeatRule?) -> String {
        let schedule = rule.map { repeatSummary($0).lowercased() } ?? "on a schedule"
        return "\"\(title)\" is set to repeat \(schedule). What would you like to do?"
    }

    static let editRepeatingTitle = "Edit Repeating Task"
    static let editRepeatingMessage = "You're editing a repeating task. Apply changes to:"
    static let editRepeatingOnlyThis = "Only this occurrence"
    static let editRepeatingThisAndFuture = "This and all future occurrences"
    static let repeatingDialogCancel = "Cancel"

    // MARK: Formatting

    /// `Jan 5` (`formatDateShort`).
    static func shortDate(_ key: String) -> String {
        TaskDates.date(key)?.formatted(.dateTime.month(.abbreviated).day()) ?? key
    }

    /// `Wed, Jan 14` (`formatQuickOptionDate`).
    static func weekdayDate(_ key: String) -> String {
        TaskDates.date(key)?.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()) ?? key
    }

    /// `Wed, Jan 14, 2026`, a preview line.
    static func previewDate(_ key: String) -> String {
        TaskDates.date(key)?.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year()) ?? key
    }

    /// `January 14`.
    static func monthDay(_ key: String) -> String {
        TaskDates.date(key)?.formatted(.dateTime.month(.wide).day()) ?? key
    }

    /// `Wednesday, January 14, 2026 · 9:00 AM`, the sheet's current choice.
    static func longDate(_ key: String?, time: String?) -> String {
        guard let key, let date = TaskDates.date(key) else { return noDate }
        let text = date.formatted(.dateTime.weekday(.wide).month(.wide).day().year())
        guard let time, let pretty = TaskDueLabel.prettyTime(time) else { return text }
        return "\(text) · \(pretty)"
    }
}
