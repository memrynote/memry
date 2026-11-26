import Testing

@testable import Memry

/// The draft rules the note title, property values and the task title share
/// (#4680). The callers' own suites drive them through their writes.
@Suite("Draft commits")
struct DraftCommitsTests {
    @Test func an_untouched_draft_follows_the_stored_value_and_restarts_from_it() {
        var commits = DraftCommits()
        commits.begin("Foo")
        #expect(commits.follow("Foo", stored: "Bar") == "Bar")
        #expect(commits.take("Bar", explicit: true) == nil, "following is not an edit")
    }

    @Test func a_touched_draft_stays_when_the_stored_value_changes() {
        var commits = DraftCommits()
        commits.begin("Foo")
        #expect(commits.follow("Food", stored: "Bar") == "Food")
        #expect(commits.take("Food", explicit: true) == "Food")
    }

    @Test func with_no_edit_the_draft_shows_the_stored_value() {
        var commits = DraftCommits()
        #expect(commits.follow("Foo", stored: "Bar") == "Bar")
    }

    /// The issue's trace: typed "Food", a peer renamed to "Bar", erased back
    /// to "Foo". The edit is where it began, so nothing is written.
    @Test func a_draft_typed_back_to_its_base_writes_nothing() {
        var commits = DraftCommits()
        commits.begin("Foo")
        #expect(commits.follow("Food", stored: "Bar") == "Food")
        #expect(commits.take("Foo", explicit: true) == nil)
    }
}
