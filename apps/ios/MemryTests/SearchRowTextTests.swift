import Foundation
import MemryCore
import Testing

@testable import Memry

// #4323: what each search hit row says and what VoiceOver reads. The emoji,
// folder and date come from the core and are pinned in Rust.

private let utc = TimeZone(identifier: "UTC")!
private let english = Locale(identifier: "en_US")

private func calendar(_ identifier: Calendar.Identifier = .gregorian) -> Calendar {
    var calendar = Calendar(identifier: identifier)
    calendar.timeZone = utc
    calendar.locale = english
    return calendar
}

/// Noon UTC on Thursday 2026-11-12.
private let thursday = calendar().date(from: DateComponents(year: 2026, month: 11, day: 12, hour: 12))!

private func hit(
    kind: String, title: String, journalDate: String? = nil, emoji: String? = nil,
    folder: String? = nil, snippet: String = "", alias: String? = nil
) -> SearchResult {
    SearchResult(
        id: "id", title: title, kind: kind, journalDate: journalDate, emoji: emoji, folderPath: folder,
        score: -1, snippet: snippet.isEmpty ? [] : [SnippetSegment(text: snippet, highlighted: false)],
        matchKind: alias == nil ? .body : .alias, matchedName: alias
    )
}

private func row(_ hit: SearchResult) -> SearchRowText {
    SearchRowText(hit: hit, now: thursday, calendar: calendar(), locale: english)
}

@Suite("Search row text")
struct SearchRowTextTests {
    @Test func a_note_row_puts_its_emoji_before_the_title_and_its_folder_under_it() {
        let text = row(hit(
            kind: "note", title: "Password list", emoji: "🔑", folder: "Work/Accounts",
            snippet: "Bank password rotates monthly."
        ))

        #expect(text.title == "🔑 Password list")
        #expect(text.caption == .folder("Work/Accounts"))
        #expect(text.accessibilityLabel == "🔑, Password list, Folder Work/Accounts, Bank password rotates monthly.")
    }

    @Test func a_note_an_alias_found_says_also_and_voiceover_reads_it() {
        let text = row(hit(
            kind: "note", title: "Password list", emoji: "🔑", folder: "Work/Accounts", alias: "Creds"
        ))

        #expect(text.also == "also: Creds")
        #expect(text.caption == .folder("Work/Accounts"))
        #expect(text.accessibilityLabel == "🔑, Password list, also Creds, Folder Work/Accounts")
    }

    @Test func a_note_without_an_emoji_or_folder_is_its_title_alone() {
        let text = row(hit(kind: "note", title: "Grocery", emoji: "custom:abc", folder: "/"))

        #expect(text.title == "Grocery")
        #expect(text.caption == nil)
        #expect(text.accessibilityLabel == "Grocery")
    }

    @Test func a_folder_path_gives_way_at_its_head_one_folder_at_a_time() {
        #expect(SearchFolderPath.candidates("Personal/Work/Accounts") == [
            "Personal/Work/Accounts", "…/Work/Accounts", "…/Accounts"
        ])
        #expect(SearchFolderPath.candidates("Kişisel") == ["Kişisel"])
    }

    @Test func a_journal_row_names_its_day_relatively_and_says_journal() {
        let text = row(hit(
            kind: "journal", title: "2026-11-10", journalDate: "2026-11-10", snippet: "the router password"
        ))

        #expect(text.title == "Nov 10")
        #expect(text.caption == .journal)
        #expect(text.accessibilityLabel == "Journal, Tuesday, November 10, the router password")
    }

    @Test func a_task_row_is_its_title_and_snippet() {
        let text = row(hit(kind: "task", title: "Rotate credentials", snippet: "update the password vault"))

        #expect(text.title == "Rotate credentials")
        #expect(text.caption == nil)
        #expect(text.accessibilityLabel == "Rotate credentials, update the password vault")
    }

    @Test func a_recent_names_its_item_as_the_hit_row_does() {
        let journal = hit(kind: "journal", title: "2026-11-10", journalDate: "2026-11-10")
        let note = hit(kind: "note", title: "Password list", emoji: "🔑", folder: "Work/Accounts")

        for item in [journal, note] {
            let recent = SearchRecent(result: item, query: "pas", visitedAt: 0)
            #expect(SearchRecentLabel(recent: recent).title == SearchRowText(hit: item).title)
        }
    }
}

@Suite("Search day label")
struct SearchDayLabelTests {
    private func label(_ day: String, calendar: Calendar = calendar(), locale: Locale = english) -> String {
        SearchDayLabel.text(day, now: thursday, calendar: calendar, locale: locale)
    }

    @Test func today_and_its_neighbours_are_named() {
        #expect(label("2026-11-12") == "Today")
        #expect(label("2026-11-11") == "Yesterday")
        #expect(label("2026-11-13") == "Tomorrow")
        #expect(label("2026-11-12", locale: Locale(identifier: "tr_TR")) == "Bugün")
    }

    @Test func a_day_two_to_six_days_ahead_is_its_weekday() {
        #expect(label("2026-11-15") == "Sun")
        #expect(label("2026-11-18") == "Wed")
        #expect(label("2026-11-19") == "Nov 19")
    }

    @Test func a_past_day_beyond_yesterday_is_month_and_day_with_the_year_only_when_it_differs() {
        #expect(label("2026-11-10") == "Nov 10")
        #expect(label("2026-07-21") == "Jul 21")
        #expect(label("2025-07-21") == "Jul 21, 2025")
    }

    @Test func a_non_gregorian_calendar_counts_its_own_years() {
        let buddhist = calendar(.buddhist)
        #expect(label("2025-07-21", calendar: buddhist).contains("2568"))
        #expect(!label("2026-07-21", calendar: buddhist).contains("25"))
    }

    @Test func a_string_that_is_not_a_day_is_shown_as_it_came() {
        #expect(label("2026-13-40") == "2026-13-40")
    }
}
