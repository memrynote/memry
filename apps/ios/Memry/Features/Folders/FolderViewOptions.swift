import Foundation
import MemryCore
import SwiftUI

// The folder screen's view options: the mobile form of desktop's folder view
// (`pages/folder-view.tsx`). Desktop is a table with columns; a phone gets the
// two parts of it that survive a narrow screen, the sort and a date grouping.
//
// **Device-local, never synced.** Both choices live in `@AppStorage`, so no
// vault format, sync payload or setting shape changes. The sort is the same
// key the vault root uses (`notes.browseSort`), so a folder and the tree above
// it never disagree about order.

/// Whether a folder's notes are split into date buckets.
enum FolderNoteGrouping: String, CaseIterable, Identifiable, Sendable {
    case none
    case date

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: "None"
        case .date: "Date"
        }
    }
}

/// One date bucket, relative to today.
enum FolderDateBucket: Int, CaseIterable, Sendable {
    case today, yesterday, previousWeek, previousMonth, older
    /// A note with no instant. Listed last in either direction, as the sort
    /// does, rather than treated as 1970.
    case undated

    var title: String {
        switch self {
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .previousWeek: "Previous 7 days"
        case .previousMonth: "Previous 30 days"
        case .older: "Older"
        case .undated: "No date"
        }
    }
}

/// A folder's notes, sorted and bucketed. A pure function so it is tested
/// without a view.
struct FolderNoteGroup: Identifiable, Equatable, Sendable {
    let bucket: FolderDateBucket
    let notes: [NoteSummary]

    var id: Int { bucket.rawValue }

    /// Buckets by the instant the sort reads: created for the created modes,
    /// modified otherwise (a name sort has no instant of its own). Buckets run
    /// newest first unless the sort runs oldest first; notes inside a bucket
    /// keep the sort's order. Empty buckets are dropped.
    static func group(
        _ notes: [NoteSummary],
        sort: BrowseSort,
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [FolderNoteGroup] {
        let sorted = sort.sorted(notes)
        let usesCreated = sort == .createdNewest || sort == .createdOldest
        let today = calendar.startOfDay(for: now)
        var buckets: [FolderDateBucket: [NoteSummary]] = [:]
        for note in sorted {
            let instant = usesCreated ? note.createdAt : note.modifiedAt
            let bucket = instant.map {
                bucketFor(Date(timeIntervalSince1970: TimeInterval($0) / 1000), today: today, calendar: calendar)
            } ?? .undated
            buckets[bucket, default: []].append(note)
        }
        let oldestFirst = sort == .modifiedOldest || sort == .createdOldest
        var order = FolderDateBucket.allCases.filter { $0 != .undated }
        if oldestFirst { order.reverse() }
        order.append(.undated)
        return order.compactMap { bucket in
            buckets[bucket].map { FolderNoteGroup(bucket: bucket, notes: $0) }
        }
    }

    private static func bucketFor(_ date: Date, today: Date, calendar: Calendar) -> FolderDateBucket {
        let day = calendar.startOfDay(for: date)
        // A clock skewed into the future still reads as today, not as older.
        let days = max(0, calendar.dateComponents([.day], from: day, to: today).day ?? 0)
        switch days {
        case 0: return .today
        case 1: return .yesterday
        case 2...7: return .previousWeek
        case 8...30: return .previousMonth
        default: return .older
        }
    }
}

/// The trailing `⋯` menu.
struct FolderViewMenu: View {
    @Binding var sort: BrowseSort
    @Binding var grouping: FolderNoteGrouping

    var body: some View {
        Menu {
            Picker(selection: $sort) {
                ForEach(BrowseSort.allCases) { option in
                    Text(option.label).tag(option)
                }
            } label: {
                Label("Sort by", systemImage: "arrow.up.arrow.down")
            }
            .pickerStyle(.menu)
            Picker(selection: $grouping) {
                ForEach(FolderNoteGrouping.allCases) { option in
                    Text(option.label).tag(option)
                }
            } label: {
                Label("Group by", systemImage: "rectangle.3.group")
            }
            .pickerStyle(.menu)
        } label: {
            Label("View options", systemImage: "ellipsis")
        }
    }
}
