import Foundation
import MemryCore

// Spec 007 CL021. Pure layout: desktop's `overlap-layout.ts` for timed chips
// and the per-week span rows of the all-day strip and the month grid.

enum CalendarLayout {
    /// `DEFAULT_DURATION_MS`: an item with no end occupies an hour.
    static let defaultDuration: TimeInterval = 3_600

    struct Lane<Item> {
        let item: Item
        let lane: Int
        let laneCount: Int
    }

    /// `assignLanes`: sort by start then longest first, cluster overlapping
    /// items, and give each the first lane free at its start.
    static func lanes<Item>(_ items: [Item], start: (Item) -> Date, end: (Item) -> Date?) -> [Lane<Item>] {
        guard !items.isEmpty else { return [] }
        let timed = items.map { item -> (Item, Date, Date) in
            let s = start(item)
            return (item, s, end(item) ?? s.addingTimeInterval(defaultDuration))
        }
        .sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.2 > $1.2 }

        var output: [Lane<Item>] = []
        var cluster: [(Item, Date, Date)] = []
        var clusterEnd = Date.distantPast
        func flush() {
            guard !cluster.isEmpty else { return }
            var laneEnds: [Date] = []
            var assigned: [Int] = []
            for entry in cluster {
                if let free = laneEnds.firstIndex(where: { $0 <= entry.1 }) {
                    laneEnds[free] = entry.2
                    assigned.append(free)
                } else {
                    laneEnds.append(entry.2)
                    assigned.append(laneEnds.count - 1)
                }
            }
            for (index, entry) in cluster.enumerated() {
                output.append(Lane(item: entry.0, lane: assigned[index], laneCount: laneEnds.count))
            }
            cluster = []
            clusterEnd = .distantPast
        }
        for entry in timed {
            if entry.1 >= clusterEnd { flush() }
            cluster.append(entry)
            clusterEnd = max(clusterEnd, entry.2)
        }
        flush()
        return output
    }

    /// One bar of a week row: the first and last column it covers there, and
    /// whether it continues from the previous week or into the next.
    struct SpanBar<Item>: Identifiable {
        let id: String
        let item: Item
        let startColumn: Int
        let endColumn: Int
        let row: Int
        let continuesBefore: Bool
        let continuesAfter: Bool
    }

    /// Lays spans across one week's columns (clipping a span to the week, as
    /// desktop's week row does), stacking bars into rows so none overlap.
    /// Longest first, then earliest, so a long span keeps the top row.
    static func spanRows<Item>(
        _ items: [Item],
        week: [String],
        key: (Item) -> String,
        first: (Item) -> String,
        last: (Item) -> String
    ) -> [SpanBar<Item>] {
        guard let weekStart = week.first, let weekEnd = week.last else { return [] }
        let clipped = items.compactMap { item -> (Item, Int, Int, Bool, Bool)? in
            let from = first(item), to = last(item)
            guard to >= weekStart, from <= weekEnd else { return nil }
            let startColumn = week.firstIndex(of: max(from, weekStart)) ?? 0
            let endColumn = week.firstIndex(of: min(to, weekEnd)) ?? week.count - 1
            return (item, startColumn, endColumn, from < weekStart, to > weekEnd)
        }
        .sorted { lhs, rhs in
            let lw = lhs.2 - lhs.1, rw = rhs.2 - rhs.1
            return lw != rw ? lw > rw : lhs.1 < rhs.1
        }
        var rows: [[ClosedRange<Int>]] = []
        var bars: [SpanBar<Item>] = []
        for entry in clipped {
            let range = entry.1 ... entry.2
            let row = rows.firstIndex { taken in !taken.contains { $0.overlaps(range) } } ?? rows.count
            if row == rows.count { rows.append([]) }
            rows[row].append(range)
            bars.append(SpanBar(
                id: "\(key(entry.0))@\(weekStart)", item: entry.0, startColumn: entry.1,
                endColumn: entry.2, row: row, continuesBefore: entry.3, continuesAfter: entry.4
            ))
        }
        return bars
    }
}

extension CalendarItem {
    var startDate: Date { CalendarDates.date(startAt) ?? Date() }
    var endDate: Date? { endAt.flatMap(CalendarDates.date) }

    /// Timed items go on the grid; all-day and multi-day ones in the strip.
    var isSpanning: Bool { isAllDay || CalendarDates.isMultiDay(self) }

    /// `hasEnded` (`calendar-item-chip.tsx`): only timed events fade (an
    /// all-day item sits at UTC midnight, so "ended" would drift); a past-due
    /// task still needs doing. A fired date reminder fades via `isTriggered`.
    func isEnded(now: Date) -> Bool {
        switch visualType {
        case "event", "external_event":
            !isAllDay && (endDate ?? startDate) <= now
        case "note_date":
            isTriggered == true
        default:
            false
        }
    }

    /// Only memrynote events and timed tasks move by drag (00 rule 1).
    var canDrag: Bool {
        editability.canMove && !isAllDay && (visualType == "event" || visualType == "task")
    }
}

extension CalendarItem: @retroactive Identifiable {
    public var id: String { projectionId }
}
