import Foundation
import MemryCore
import Testing

@testable import Memry

// JP042–JP044: the Month rows (future / today / no entry / not pulled), the
// Month and Year subtitles, ‹ › across year boundaries, the Year cards'
// current and future flags, and the VoiceOver sentences of JP057.

@MainActor
@Suite("Journal calendar")
struct JournalCalendarTests {
    private func day(
        _ date: String,
        today: Bool = false,
        future: Bool = false,
        entry: Bool = false,
        level: UInt8 = 0,
        preview: String = "",
        body: JournalBody? = nil
    ) -> JournalMonthDayRecord {
        JournalMonthDayRecord(
            date: date,
            isToday: today,
            isFuture: future,
            hasEntry: entry,
            level: level,
            preview: preview,
            characterCount: UInt64(preview.count),
            body: body
        )
    }

    // MARK: Month rows

    @Test func a_future_day_without_text_reads_future() {
        let row = JournalMonthRowModel(day("2026-09-30", future: true))
        #expect(row.state == .future)
        #expect(row.state.text == "Future")
        #expect(row.state.isPlaceholder)
        #expect(row.opacity == 0.6)
        #expect(row.level == 0)
    }

    @Test func an_empty_past_day_reads_no_entry() {
        let row = JournalMonthRowModel(day("2026-09-21"))
        #expect(row.state == .noEntry)
        #expect(row.state.text == "No entry")
        #expect(row.opacity == 0.5)
        #expect(row.accessibilityLabel == "Monday 21, No entry")
    }

    @Test func today_without_text_reads_no_entry_undimmed() {
        let row = JournalMonthRowModel(day("2026-09-24", today: true))
        #expect(row.isToday)
        #expect(row.state == .noEntry)
        #expect(row.opacity == 1)
    }

    @Test func a_day_with_text_shows_its_preview_and_level() {
        let row = JournalMonthRowModel(
            day("2026-09-24", today: true, entry: true, level: 3, preview: "Slept well.", body: .present)
        )
        #expect(row.state == .entry(preview: "Slept well."))
        #expect(!row.state.isPlaceholder)
        #expect(row.level == 3)
        #expect(row.day == 24)
        #expect(JournalCopy.weekdayShort(row.weekday) == "Thu")
        #expect(row.accessibilityLabel == "Thursday 24, entry, Slept well.")
    }

    @Test func a_future_day_with_text_shows_its_preview() {
        let row = JournalMonthRowModel(day("2026-09-30", future: true, entry: true, level: 1, preview: "Plan"))
        #expect(row.state == .entry(preview: "Plan"))
        #expect(row.opacity == 1)
    }

    @Test func a_day_whose_body_is_not_pulled_says_so() {
        let row = JournalMonthRowModel(day("2026-09-23", entry: true, level: 2, body: .notPulled))
        #expect(row.state == .notPulled)
        #expect(row.state.text == JournalCopy.notOnThisPhone)
        #expect(row.accessibilityLabel == "Wednesday 23, \(JournalCopy.notOnThisPhone)")
    }

    @Test func real_month_rows_map_today_future_entry_and_no_entry() async throws {
        let vault = try JournalTestVault()
        try vault.write("Walked to the lake.", on: "2099-06-14")
        let month = try #require(await vault.store.loadMonth(year: 2099, month: 6))
        let rows = Dictionary(uniqueKeysWithValues: month.days.map { ($0.date, JournalMonthRowModel($0)) })
        #expect(rows["2099-06-16"]?.state == .future)
        #expect(rows["2099-06-15"]?.isToday == true)
        #expect(rows["2099-06-15"]?.state == .noEntry)
        #expect(rows["2099-06-14"]?.state == .entry(preview: "Walked to the lake."))
        #expect((rows["2099-06-14"]?.level ?? 0) > 0)
        #expect(rows["2099-06-13"]?.state == .noEntry)
        #expect(try vault.journal.entryId(date: "2099-06-15") == nil, "showing a month creates no day")
    }

    // MARK: Subtitles

    @Test func the_month_subtitle_names_year_entries_and_streak() {
        let subtitle = JournalMonthSubtitle(year: 2026, entryCount: 17, streak: 6)
        #expect(subtitle.lead == "2026 · 17 entries")
        #expect(subtitle.streak == "6-day streak")
        #expect(subtitle.text == "2026 · 17 entries · 6-day streak")
    }

    @Test func the_month_subtitle_drops_a_streak_that_is_not_running() {
        let subtitle = JournalMonthSubtitle(year: 2026, entryCount: 1, streak: 0)
        #expect(subtitle.streak == nil)
        #expect(subtitle.text == "2026 · 1 entry")
    }

    @Test func the_year_subtitle_names_days_streak_and_best() {
        #expect(JournalYearSubtitle(daysWithEntries: 135, streak: 6, best: 21).text == "135 days · 6-day streak · best 21")
        #expect(JournalYearSubtitle(daysWithEntries: 4, streak: 0, best: 3).text == "4 days · best 3")
        #expect(JournalYearSubtitle(daysWithEntries: 0, streak: 0, best: 0).text == "0 days")
    }

    // MARK: Month stepping

    @Test func month_steps_cross_year_boundaries() {
        #expect(JournalMonthStep.shifted(year: 2026, month: 1, by: -1) == (2025, 12))
        #expect(JournalMonthStep.shifted(year: 2025, month: 12, by: 1) == (2026, 1))
        #expect(JournalMonthStep.shifted(year: 2026, month: 6, by: 1) == (2026, 7))
        #expect(JournalMonthStep.shifted(year: 2026, month: 6, by: 14) == (2027, 8))
        #expect(JournalMonthStep.shifted(year: 2026, month: 2, by: -14) == (2024, 12))
    }

    @Test func stepping_a_month_replaces_the_month_on_the_stack() {
        let router = JournalRouter(today: "2099-06-15")
        router.openMonth(year: 2099, month: 1)
        let previous = JournalMonthStep.shifted(year: 2099, month: 1, by: -1)
        router.openMonth(year: previous.year, month: previous.month)
        #expect(router.path == [.month(year: 2098, month: 12)])
        #expect(router.rootYear == 2098)
    }

    // MARK: Year cards

    private func card(_ month: UInt32, count: UInt32 = 0, dots: [UInt8] = []) -> JournalMonthCard {
        JournalMonthCard(month: month, entryCount: count, totalCharacters: 0, activityDots: Data(dots))
    }

    @Test func the_current_month_is_current_and_later_months_are_future() {
        let today = "2099-06-15"
        let june = JournalYearCardModel(card(5, count: 3), year: 2099, today: today)
        #expect(june.month == 6)
        #expect(june.isCurrent)
        #expect(!june.isFuture)
        let may = JournalYearCardModel(card(4), year: 2099, today: today)
        #expect(!may.isCurrent && !may.isFuture)
        let july = JournalYearCardModel(card(6), year: 2099, today: today)
        #expect(july.isFuture && !july.isCurrent)
        let nextYear = JournalYearCardModel(card(0), year: 2100, today: today)
        #expect(nextYear.isFuture)
        let lastYear = JournalYearCardModel(card(11), year: 2098, today: today)
        #expect(!lastYear.isFuture && !lastYear.isCurrent)
    }

    @Test func year_cards_pad_dots_to_five_and_read_month_and_days() {
        let september = JournalYearCardModel(card(8, count: 17, dots: [2, 3]), year: 2026, today: "2026-09-24")
        #expect(september.dots == [2, 3, 0, 0, 0])
        #expect(september.accessibilityLabel == "September, 17 days")
        let one = JournalYearCardModel(card(0, count: 1), year: 2026, today: "2026-09-24")
        #expect(one.accessibilityLabel == "January, 1 day")
    }
}
