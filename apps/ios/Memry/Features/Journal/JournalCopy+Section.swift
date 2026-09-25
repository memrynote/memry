import Foundation

// JP050, JP052. The Day section's words (Paper J01, J03, J10: "Due today",
// "Due Sep 21", "2 overdue"; desktop `journal.json` `count.overdue`) and the
// cross-tab rows that open a day.

extension JournalCopy {
    enum Section {
        static let dueToday = "Due today"

        /// "Due Sep 21" for a `YYYY-MM-DD` key.
        static func due(on date: String) -> String {
            let (_, month) = JournalDates.yearMonth(date)
            return "Due \(JournalCopy.monthShort(month)) \(JournalDates.day(date))"
        }

        /// The header's count, as VoiceOver reads it.
        static func taskCount(_ count: Int) -> String {
            count == 1 ? "1 task" : "\(count) tasks"
        }

        /// desktop `count.overdue`.
        static func overdue(_ count: Int) -> String { "\(count) overdue" }

        static let overdueHint = "Opens Tasks"
    }

    /// The label a journal row carries outside the tab (search, backlinks).
    static let journalKind = "Journal"
    static let openInJournal = "Opens the day in Journal"
}
