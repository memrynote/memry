import Foundation
import MemryCore
import Testing

@testable import Memry

// JP040, JP041, JP051: the Day page's bridge onto the note page seams, the
// placeholder and header copy by relative day, the stats footer line, and
// the first edit creating the day through the bridge (D2).

@MainActor
@Suite("Journal day page", .serialized)
struct JournalDayTests {
    private static func record(
        body: JournalBody,
        tags: [String] = [],
        properties: [NoteProperty] = []
    ) -> JournalDayRecord {
        JournalDayRecord(
            id: "j2099-06-15",
            date: "2099-06-15",
            tags: tags,
            properties: properties,
            createdAt: 1000,
            modifiedAt: 2000,
            wordCount: 3,
            characterCount: 14,
            body: body
        )
    }

    private static func property(_ name: String, _ json: String) -> NoteProperty {
        NoteProperty(name: name, valueJson: json, typeName: "text", optionsJson: nil, color: nil)
    }

    // MARK: Synthesised detail

    @Test func a_present_day_reads_as_a_note_titled_by_its_date_with_its_text() {
        let detail = JournalNoteBridge.detail(date: "2099-06-15", day: Self.record(body: .present), text: "Hello there")
        #expect(detail.summary.id == "j2099-06-15")
        #expect(detail.summary.title == "2099-06-15")
        #expect(detail.summary.folderPath == nil)
        #expect(detail.summary.modifiedAt == 2000)
        #expect(detail.body.present)
        #expect(NoteBodyPreview.of(detail.body) == .text("Hello there"))
    }

    @Test func an_empty_day_reads_as_a_present_empty_body() {
        let detail = JournalNoteBridge.detail(date: "2099-06-15", day: Self.record(body: .empty), text: "")
        #expect(NoteBodyPreview.of(detail.body) == .empty)
    }

    @Test func a_day_whose_body_is_not_pulled_never_reads_as_empty() {
        let detail = JournalNoteBridge.detail(date: "2099-06-15", day: Self.record(body: .notPulled), text: "stale")
        #expect(detail.body.present == false)
        #expect(NoteBodyPreview.of(detail.body) == .notPulled)
    }

    @Test func a_day_with_no_entry_reads_as_an_empty_body_under_its_new_id() {
        let detail = JournalNoteBridge.detail(date: "2099-06-12", day: nil, text: "")
        #expect(detail.summary.id == "j2099-06-12")
        #expect(detail.summary.title == "2099-06-12")
        #expect(detail.summary.createdAt == nil)
        #expect(NoteBodyPreview.of(detail.body) == .empty)
    }

    @Test func metadata_carries_tags_and_properties_without_date() {
        let day = Self.record(
            body: .present,
            tags: ["morning", "gratitude"],
            properties: [Self.property("Mood", "\"Calm\""), Self.property("date", "\"2099-06-15\"")]
        )
        let metadata = JournalNoteBridge.metadata(day)
        #expect(metadata.tags == ["morning", "gratitude"])
        #expect(metadata.properties.map(\.name) == ["Mood"])
        #expect(metadata.aliases.isEmpty)
        #expect(metadata.icon == nil)
        #expect(metadata.coverJson == nil)
        let absent = JournalNoteBridge.metadata(nil)
        #expect(absent.tags.isEmpty)
        #expect(absent.properties.isEmpty)
    }

    // MARK: Copy by relative day

    @Test func the_placeholder_follows_the_day_relative_to_today() {
        let today = "2099-06-15"
        #expect(JournalCopy.placeholder(date: today, today: today) == JournalCopy.placeholderToday)
        #expect(JournalCopy.placeholder(date: "2099-06-14", today: today) == JournalCopy.placeholderPast)
        #expect(JournalCopy.placeholder(date: "2098-01-01", today: today) == JournalCopy.placeholderPast)
        #expect(JournalCopy.placeholder(date: "2099-06-16", today: today) == JournalCopy.placeholderFuture)
    }

    @Test func the_header_lines_read_like_paper() {
        let today = "2099-06-15"
        let weekday = JournalCopy.weekdayName(JournalCopy.weekday(of: today))
        #expect(JournalCopy.weekdayLine(date: today, today: today) == weekday)
        let past = JournalCopy.weekdayName(JournalCopy.weekday(of: "2099-06-12"))
        #expect(JournalCopy.weekdayLine(date: "2099-06-12", today: today) == "\(past) · 3 days ago")
        #expect(JournalCopy.dayTitle("2099-09-24") == "September 24")
        #expect(JournalCopy.inlineTitle("2026-09-24") == "Thu, Sep 24")
        #expect(JournalCopy.weekday(of: "2026-09-21") == 1, "Monday")
    }

    // MARK: Stats footer

    @Test func reading_time_rounds_up_at_200_words_a_minute() {
        #expect(JournalCopy.readingTime(words: 0) == "< 1 min")
        #expect(JournalCopy.readingTime(words: 1) == "1 min")
        #expect(JournalCopy.readingTime(words: 200) == "1 min")
        #expect(JournalCopy.readingTime(words: 201) == "2 min")
        #expect(JournalCopy.readingTime(words: 1000) == "5 min")
    }

    @Test func the_stats_line_lists_words_characters_reading_time_and_modified() {
        let line = JournalCopy.statsLine(words: 142, characters: 812, modifiedAt: nil, createdAt: nil)
        #expect(line == "142 words · 812 characters · 1 min read · Modified —")
        let dated = JournalCopy.statsLine(words: 0, characters: 0, modifiedAt: nil, createdAt: 0)
        #expect(dated.hasPrefix("0 words · 0 characters · < 1 min read · Modified "))
        #expect(!dated.hasSuffix("—"), "falls back to the created instant")
    }

    // MARK: Moving between days

    @Test func the_window_holds_the_neighbours_and_journal_ids_name_their_day() {
        #expect(JournalDayScreen.window(around: "2099-12-31") == ["2099-12-30", "2099-12-31", "2100-01-01"])
        #expect(JournalDayScreen.journalDate(ofId: "j2099-06-15") == "2099-06-15")
        #expect(JournalDayScreen.journalDate(ofId: "j2099-02-30") == nil)
        #expect(JournalDayScreen.journalDate(ofId: "note-1") == nil)
    }

    // MARK: Through a real vault

    @Test func reading_a_day_through_the_bridge_creates_nothing() async throws {
        let vault = try JournalTestVault()
        let bridge = JournalNoteBridge(store: vault.store, date: JournalTestVault.today)
        let detail = try #require(try await bridge.read(id: "j2099-06-15"))
        #expect(NoteBodyPreview.of(detail.body) == .empty)
        let metadata = try #require(try await bridge.metadata(id: "j2099-06-15"))
        #expect(metadata.tags.isEmpty)
        #expect(try vault.journal.entryId(date: JournalTestVault.today) == nil)
    }

    @Test func the_first_edit_through_the_bridge_creates_the_day() async throws {
        let vault = try JournalTestVault()
        vault.store.context = JournalVaultContext(
            reader: CoreNotesReader(vault: vault.vault, executor: CoreExecutor()),
            filler: nil,
            writer: nil,
            editor: nil,
            metadataWriter: nil,
            search: nil,
            noteTasks: nil
        )
        var syncs = 0
        vault.store.requestSync = { syncs += 1 }
        let bridge = JournalNoteBridge(store: vault.store, date: JournalTestVault.today)

        let landed = try await bridge.edit(
            noteId: "j2099-06-15",
            .insertParagraph(afterBlockId: nil, text: "Walked to the lake.", newBlockId: "b1")
        )

        #expect(landed)
        #expect(syncs == 1)
        #expect(try vault.journal.entryId(date: JournalTestVault.today) == "j2099-06-15")
        #expect(vault.store.cachedDay(JournalTestVault.today)?.wordCount == 4)
        let detail = try #require(try await bridge.read(id: "j2099-06-15"))
        #expect(NoteBodyPreview.of(detail.body) == .text("Walked to the lake."))
        let blocks = try #require(try await bridge.blocks(id: "j2099-06-15"))
        #expect(blocks.count == 1)
    }

    @Test func a_bridge_edit_lands_on_its_own_date() async throws {
        let vault = try JournalTestVault()
        let yesterday = JournalDates.adding(-1, to: JournalTestVault.today)
        let bridge = JournalNoteBridge(store: vault.store, date: yesterday)
        _ = try await bridge.edit(
            noteId: "j\(yesterday)",
            .insertParagraph(afterBlockId: nil, text: "late", newBlockId: "b1")
        )
        #expect(try vault.journal.entryId(date: yesterday) == "j\(yesterday)")
        #expect(try vault.journal.entryId(date: JournalTestVault.today) == nil)
    }

    @Test func hidden_metadata_reads_as_none() async throws {
        let vault = try JournalTestVault()
        try vault.write("text", on: JournalTestVault.today)
        _ = try vault.journal.setTags(date: JournalTestVault.today, tags: ["a"])
        let hidden = JournalNoteBridge(store: vault.store, date: JournalTestVault.today, exposesMetadata: false)
        #expect(try await hidden.metadata(id: "j2099-06-15")?.tags.isEmpty == true)
        let shown = JournalNoteBridge(store: vault.store, date: JournalTestVault.today)
        #expect(try await shown.metadata(id: "j2099-06-15")?.tags == ["a"])
    }
}
