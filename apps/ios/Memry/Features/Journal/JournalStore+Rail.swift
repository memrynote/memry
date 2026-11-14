import Foundation
import MemryCore

// #4351 (D8). "On this day" in the Journal rail: the shown day in other
// years (desktop `journal-past-years.tsx` over `getJournalSameDayEntries`).
// A pure read through the core; nothing is written or cached.

/// One other year's entry for the shown day.
struct JournalSameDayEntry: Equatable, Identifiable {
    let date: String
    let preview: String
    let level: UInt8
    var id: String { date }
}

extension JournalStore {
    /// The same day in every other year, later ones included, newest first,
    /// each with the core's preview (`Journal.sameDayEntries`, desktop
    /// `getJournalSameDayEntries`). `nil` when the read failed (already reported).
    func sameDayEntries(_ date: String) async -> [JournalSameDayEntry]? {
        let today = today
        return await read { core in
            try core.sameDayEntries(date: date, today: today).map {
                JournalSameDayEntry(date: $0.date, preview: $0.preview, level: $0.level)
            }
        }
    }
}
