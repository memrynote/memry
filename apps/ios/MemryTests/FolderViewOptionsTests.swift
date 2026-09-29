import Foundation
import MemryCore
import Testing

@testable import Memry

// The folder screen's date grouping is a pure function over notes, a sort and
// a fixed "now", so it is asserted without a view or a clock.

@Suite("Folder view options")
struct FolderViewOptionsTests {
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }()

    /// 2025-06-15 12:00 UTC.
    private static let now = Date(timeIntervalSince1970: 1_749_988_800)

    private static func ms(daysAgo: Double) -> Int64 {
        Int64((now.timeIntervalSince1970 - daysAgo * 86_400) * 1000)
    }

    private static func note(_ id: String, _ title: String, modified: Int64?, created: Int64? = nil) -> NoteSummary {
        NoteSummary(id: id, title: title, folderPath: "Work", emoji: nil, createdAt: created, modifiedAt: modified)
    }

    private static let notes = [
        note("old", "Kickoff", modified: ms(daysAgo: 90)),
        note("today", "Standup", modified: ms(daysAgo: 0.1)),
        note("undated", "Scratch", modified: nil),
        note("week", "Retro", modified: ms(daysAgo: 4)),
        note("yesterday", "Plan", modified: ms(daysAgo: 1))
    ]

    private static func group(_ sort: BrowseSort, _ notes: [NoteSummary] = notes) -> [FolderNoteGroup] {
        FolderNoteGroup.group(notes, sort: sort, now: now, calendar: calendar)
    }

    @Test("Newest first: buckets run newest to oldest, undated last, empty ones dropped")
    func newestFirst() {
        let groups = Self.group(.modifiedNewest)
        #expect(groups.map(\.bucket) == [.today, .yesterday, .previousWeek, .older, .undated])
        #expect(groups.flatMap(\.notes).map(\.id) == ["today", "yesterday", "week", "old", "undated"])
    }

    @Test("Oldest first reverses the buckets but keeps undated last")
    func oldestFirst() {
        let groups = Self.group(.modifiedOldest)
        #expect(groups.map(\.bucket) == [.older, .previousWeek, .yesterday, .today, .undated])
    }

    @Test("A name sort buckets by modified date and orders by name inside a bucket")
    func nameSortInsideBucket() {
        let notes = [
            Self.note("b", "Beta", modified: Self.ms(daysAgo: 0.2)),
            Self.note("a", "alpha", modified: Self.ms(daysAgo: 0.1))
        ]
        let groups = Self.group(.nameAscending, notes)
        #expect(groups.map(\.bucket) == [.today])
        #expect(groups[0].notes.map(\.id) == ["a", "b"])
    }

    @Test("A created sort buckets by the created instant")
    func createdSortUsesCreated() {
        let notes = [Self.note("n", "Note", modified: Self.ms(daysAgo: 0), created: Self.ms(daysAgo: 20))]
        #expect(Self.group(.createdNewest, notes).map(\.bucket) == [.previousMonth])
        #expect(Self.group(.modifiedNewest, notes).map(\.bucket) == [.today])
    }

    @Test("No note is dropped")
    func keepsEveryNote() {
        for sort in BrowseSort.allCases {
            #expect(Self.group(sort).flatMap(\.notes).count == Self.notes.count)
        }
    }
}
