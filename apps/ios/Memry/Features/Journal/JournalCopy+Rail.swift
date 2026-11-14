import Foundation

// #4351. The Journal rail's words: the mini calendar, the day's agenda
// (desktop `journal.json` `dayTimeline.*`, `section.tasks`) and On this day
// (`pastYears.*`).

extension JournalCopy {
    enum Rail {
        static let label = "Day details"

        // MARK: Mini calendar

        static let previousMonth = "Previous month"
        static let nextMonth = "Next month"

        /// "Thursday, September 24, entry" for a calendar cell.
        static func dayCell(_ date: String, hasEntry: Bool) -> String {
            let spoken = "\(JournalCopy.weekdayName(JournalCopy.weekday(of: date))), "
                + "\(JournalCopy.monthName(JournalDates.yearMonth(date).month)) \(JournalDates.day(date))"
            return hasEntry ? "\(spoken), \(JournalCopy.entryAccessibility)" : spoken
        }

        // MARK: Agenda

        static let schedule = "Day schedule"
        static let allDay = "All day"
        static let noSchedule = "Nothing scheduled"
        static let openEvent = "Opens it in Calendar"

        // MARK: On this day

        static let onThisDay = "On this day"

        /// `pastYears.count`.
        static func otherYears(_ count: Int) -> String {
            count == 1 ? "1 other year" : "\(count) other years"
        }

        /// How far `entry` is from the `shown` day (desktop
        /// `journal-past-years.tsx`): "Today" when it is today.
        static func sameDayDistance(_ entry: String, shown: String, today: String) -> String {
            guard entry != today else { return JournalCopy.today }
            return yearsAway(JournalDates.yearMonth(shown).year - JournalDates.yearMonth(entry).year)
        }

        /// `pastYears.yearsAgo` / `yearsLater`.
        private static func yearsAway(_ years: Int) -> String {
            switch years {
            case 1: "1 year ago"
            case 2...: "\(years) years ago"
            case -1: "1 year later"
            default: "\(-years) years later"
            }
        }

        static let sameDayLoadError = "Couldn't load this day from other years."
    }
}
