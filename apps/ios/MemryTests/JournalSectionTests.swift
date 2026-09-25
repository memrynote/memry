import Foundation
import MemryCore
import Testing

@testable import Memry

// JP050, JP052: the Day section's task filter, the day a link names, and a
// journal backlink's row. Pure values; the routes themselves are one
// environment call each.

/// A reader holding one note title, for the wiki-link fallback.
private struct WikiReader: NotesReading {
    let notes: [String: String]
    var failure = false

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }
    func read(id: String) async throws -> NoteDetail? { nil }

    func resolveWikiTarget(_ target: String) async throws -> String? {
        if failure { throw StorageError.Failed(what: "the index is locked") }
        return notes[target]
    }
}

private func task(
    _ id: String,
    due: String?,
    priority: Int64 = 0,
    completedAt: String? = nil,
    archivedAt: String? = nil
) -> TaskItem {
    TaskItem(
        id: id, title: id, description: nil, projectId: "inbox", statusId: nil, parentId: nil,
        priority: priority, position: 0, dueDate: due, dueTime: nil, startDate: nil,
        repeat: nil, isRepeating: false, repeatFrom: nil, sourceNoteId: nil,
        completedAt: completedAt, archivedAt: archivedAt, tags: [], linkedNoteIds: [], linkedCanvasIds: [],
        createdAt: nil, modifiedAt: nil, statusType: nil, isDone: completedAt != nil
    )
}

private func backlink(
    _ id: String,
    title: String,
    kind: String = "note",
    date: String? = nil,
    viaProperty: Bool = false
) -> BacklinkRow {
    BacklinkRow(
        sourceId: id, sourceTitle: title, sourceKind: kind, sourceDate: date,
        targetTitle: "Target", viaProperty: viaProperty, stamp: 0
    )
}

@MainActor
@Suite("Journal section and cross-tab routes")
struct JournalSectionTests {
    // MARK: The day a link names

    @Test func a_wiki_target_names_a_day_by_date_or_journal_id() {
        #expect(JournalLink.date(fromWikiTarget: "2099-06-15") == "2099-06-15")
        #expect(JournalLink.date(fromWikiTarget: "j2099-06-15") == "2099-06-15")
        #expect(JournalLink.date(fromWikiTarget: "  2099-06-15 ") == "2099-06-15")
    }

    @Test func a_wiki_target_that_is_not_a_real_day_names_none() {
        #expect(JournalLink.date(fromWikiTarget: "2099-02-30") == nil)
        #expect(JournalLink.date(fromWikiTarget: "2099-6-1") == nil)
        #expect(JournalLink.date(fromWikiTarget: "j2099-13-01") == nil)
        #expect(JournalLink.date(fromWikiTarget: "Meeting notes") == nil)
        #expect(JournalLink.date(fromWikiTarget: "") == nil)
    }

    @Test func a_journal_id_needs_its_j_prefix() {
        #expect(JournalLink.date(fromJournalId: "j2099-06-15") == "2099-06-15")
        #expect(JournalLink.date(fromJournalId: "2099-06-15") == nil)
        #expect(JournalLink.date(fromJournalId: "jabc") == nil)
        #expect(JournalLink.route(forDay: "2099-06-15") == NoteRoute(id: "j2099-06-15"))
    }

    @Test func a_wiki_link_prefers_a_note_then_falls_back_to_the_day() async {
        let reader = WikiReader(notes: ["2099-06-15": "note-titled-a-date", "Plan": "plan"])
        let model = NoteReadViewModel(route: NoteRoute(id: "here"), reader: reader)
        #expect(await model.wikiTarget(for: "Plan") == NoteRoute(id: "plan"))
        #expect(await model.wikiTarget(for: "2099-06-15") == NoteRoute(id: "note-titled-a-date"), "a note wins")
        #expect(await model.wikiTarget(for: "2099-06-14") == NoteRoute(id: "j2099-06-14"))
        #expect(await model.wikiTarget(for: "j2099-06-13") == NoteRoute(id: "j2099-06-13"))
        #expect(await model.wikiTarget(for: "Nowhere") == nil, "still a broken link")
    }

    @Test func a_failed_lookup_is_not_read_as_a_day() async {
        let model = NoteReadViewModel(route: NoteRoute(id: "here"), reader: WikiReader(notes: [:], failure: true))
        #expect(await model.wikiTarget(for: "2099-06-14") == nil)
    }

    // MARK: Backlink rows

    @Test func a_journal_backlink_is_titled_and_routed_by_its_date() {
        let entry = BacklinkEntry.of(backlink("jr-1", title: "2099-06-15", kind: "journal", date: "2099-06-15"))
        #expect(entry.title == "2099-06-15")
        #expect(entry.destination == .journalDay("2099-06-15"))
        #expect(entry.id == "jr-1")
    }

    @Test func a_journal_backlink_without_a_date_falls_back_to_its_id() {
        let entry = BacklinkEntry.of(backlink("j2099-06-14", title: "", kind: "journal"))
        #expect(entry.destination == .journalDay("2099-06-14"))
        #expect(entry.title == "2099-06-14")
    }

    @Test func a_note_backlink_pushes_the_note() {
        let entry = BacklinkEntry.of(backlink("n-1", title: "Weekly review"))
        #expect(entry.title == "Weekly review")
        #expect(entry.destination == .note(NoteRoute(id: "n-1")))
        #expect(BacklinkEntry.of(backlink("n-2", title: "")).title == "Untitled note")
        #expect(BacklinkEntry.of(backlink("n-3", title: "Src", viaProperty: true)).title == "Target → Src")
    }

    // MARK: Tasks due on the day

    @Test func the_day_shows_tasks_due_that_day_completed_included_archived_not() {
        let tasks = [
            task("low", due: "2099-06-15", priority: 1),
            task("other-day", due: "2099-06-16", priority: 4),
            task("timed", due: "2099-06-15T10:00:00", priority: 3),
            task("done", due: "2099-06-15", completedAt: "2099-06-15T09:00:00"),
            task("archived", due: "2099-06-15", priority: 4, archivedAt: "2099-06-01"),
            task("undated", due: nil, priority: 4),
            task("low-2", due: "2099-06-15", priority: 1)
        ]
        let due = JournalDayTasks.due(on: "2099-06-15", in: tasks).map(\.id)
        #expect(due == ["timed", "low", "low-2", "done"], "priority first, list order within one")
        #expect(JournalDayTasks.due(on: "2099-06-17", in: tasks).isEmpty)
    }

    @Test func overdue_counts_open_unarchived_tasks_before_today() {
        let tasks = [
            task("late", due: "2099-06-10"),
            task("late-timed", due: "2099-06-14T23:00:00"),
            task("late-done", due: "2099-06-10", completedAt: "2099-06-11T08:00:00"),
            task("late-archived", due: "2099-06-10", archivedAt: "2099-06-12"),
            task("today", due: "2099-06-15"),
            task("undated", due: nil)
        ]
        #expect(JournalDayTasks.overdueCount(before: "2099-06-15", in: tasks) == 2)
    }

    @Test func the_header_names_the_day() {
        #expect(JournalCopy.Section.due(on: "2099-09-21") == "Due Sep 21")
        #expect(JournalCopy.Section.due(on: "2099-01-05") == "Due Jan 5")
        #expect(JournalCopy.Section.overdue(2) == "2 overdue")
    }
}
