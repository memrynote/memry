import Foundation
import MemryCore

// The search sheet's filters (#4321): a single-select scope over the types,
// and a menu holding one date preset and any number of tags. The core applies
// them (`domain/search/filter.rs`); the shell owns only the choice and the
// local calendar that turns a preset into epoch milliseconds.

/// The scope picker under the search field.
enum SearchScope: CaseIterable, Hashable {
    case all, notes, journal, tasks, inbox

    var title: String {
        switch self {
        case .all: "All"
        case .notes: "Notes"
        case .journal: "Journal"
        case .tasks: "Tasks"
        case .inbox: "Inbox"
        }
    }

    /// The core's types for this scope; empty searches every type.
    var types: [SearchType] {
        switch self {
        case .all: []
        case .notes: [.note]
        case .journal: [.journal]
        case .tasks: [.task]
        case .inbox: [.inbox]
        }
    }
}

/// Desktop's three modified-date presets (`search-date-presets.ts`).
enum SearchDatePreset: CaseIterable, Hashable {
    case today, thisWeek, thisMonth

    var title: String {
        switch self {
        case .today: "Today"
        case .thisWeek: "This week"
        case .thisMonth: "This month"
        }
    }

    /// From the start of the preset's first local day to the end of today,
    /// both inclusive, as desktop's `datePresetRange`. The week starts on the
    /// calendar's `firstWeekday`, which `Calendar.current` takes from the
    /// user's region.
    func range(now: Date, calendar: Calendar) -> ModifiedRange {
        let unit: Calendar.Component = switch self {
        case .today: .day
        case .thisWeek: .weekOfYear
        case .thisMonth: .month
        }
        let today = calendar.dateInterval(of: .day, for: now)
        let start = calendar.dateInterval(of: unit, for: now)?.start ?? today?.start ?? now
        let end = today?.end ?? now
        return ModifiedRange(fromMs: Self.milliseconds(start), toMs: Self.milliseconds(end) - 1)
    }

    private static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }
}

/// What the scope picker and the filter menu hold.
struct SearchFilters: Equatable {
    var scope: SearchScope = .all
    var date: SearchDatePreset?
    var tags: Set<String> = []

    /// Whether the filter menu narrows anything, which fills its icon.
    var isNarrowed: Bool { date != nil || !tags.isEmpty }

    /// Picks `preset`, or clears it when it is already picked.
    mutating func toggle(_ preset: SearchDatePreset) {
        date = date == preset ? nil : preset
    }

    mutating func toggle(tag: String) {
        if tags.remove(tag) == nil { tags.insert(tag) }
    }

    /// Clears the menu's date and tags. The scope is its own control.
    mutating func clear() {
        date = nil
        tags = []
    }

    /// The core's filter, or `nil` when nothing is narrowed.
    func record(now: Date, calendar: Calendar) -> SearchFilter? {
        guard scope != .all || isNarrowed else { return nil }
        return SearchFilter(
            types: scope.types,
            modified: date?.range(now: now, calendar: calendar),
            tags: tags.sorted()
        )
    }
}
