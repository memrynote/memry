import Foundation
import MemryCore
import Testing

@testable import Memry

// IB030 / IB032 / IB09: the inbox store over a real scratch vault, and the
// formatting every row and menu shows.

@MainActor
struct InboxTestVault {
    let vault: Vault
    let inbox: Inbox
    let store: InboxStore
    let directory: URL

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("memry-inbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        vault = try Vault.open(vaultId: "vault-inbox-test", directory: directory.path)
        inbox = try vault.inbox(store: TaskTestKeychain())
        store = InboxStore(core: inbox, vaultId: "vault-inbox-test", vaultDirectory: directory, filler: nil)
    }
}

private func record(
    type: String = "note",
    title: String = "[agent] thing",
    created: Date,
    metadata: String? = nil,
    sourceUrl: String? = nil,
    transcription: String? = nil,
    transcriptionStatus: String? = nil
) -> InboxItemRecord {
    InboxItemRecord(
        id: UUID().uuidString, itemType: type, title: title, content: nil, metadataJson: metadata,
        filedAtMs: nil, filedTo: nil, filedAction: nil, snoozedUntilMs: nil, snoozeReason: nil,
        archivedAtMs: nil, viewedAtMs: nil, sourceUrl: sourceUrl, sourceTitle: nil, captureSource: nil,
        processingStatus: nil, transcription: transcription, transcriptionStatus: transcriptionStatus,
        attachmentPath: nil, thumbnailPath: nil, createdAtMs: Int64(created.timeIntervalSince1970 * 1000),
        modifiedAtMs: nil, tags: [], isNoteOnly: false, isBinary: false
    )
}

@Suite("Inbox formatting")
struct InboxFormattingTests {
    let now = Date(timeIntervalSince1970: 1_790_251_200) // 2026-09-24 12:00 UTC

    @Test func ages_follow_format_compact_relative_time() {
        #expect(InboxMeta.age(now.addingTimeInterval(-20), now: now) == "now")
        #expect(InboxMeta.age(now.addingTimeInterval(-12 * 60), now: now) == "12m")
        #expect(InboxMeta.age(now.addingTimeInterval(-3 * 3600), now: now) == "3h")
        #expect(InboxMeta.age(now.addingTimeInterval(-9 * 86_400), now: now) == "9d")
        #expect(InboxMeta.duration(42) == "0:42")
        #expect(InboxMeta.duration(125.9) == "2:05")
    }

    @Test func a_link_row_says_domain_then_age() {
        let row = InboxRowText.make(record(type: "link", created: now.addingTimeInterval(-600),
                                           sourceUrl: "https://www.linear.app/blog"), now: now)
        #expect(row.meta.map(\.text) == ["linear.app", "10m"])
        #expect(row.preview == nil)
    }

    @Test func a_voice_row_adds_its_transcript_and_amber_duration() {
        let row = InboxRowText.make(record(type: "voice", created: now.addingTimeInterval(-3600),
                                           metadata: #"{"duration":42}"#, transcription: "Pick up the cable"), now: now)
        #expect(row.preview == "“Pick up the cable”")
        #expect(row.meta.first == InboxMetaPart(text: "0:42", accented: true))
        let pending = InboxRowText.make(record(type: "voice", created: now, transcriptionStatus: "pending"), now: now)
        #expect(pending.preview == InboxCopy.transcribing)
    }

    @Test func pdf_pages_reminder_kind_and_stale_age() {
        let pdf = InboxRowText.make(record(type: "pdf", created: now.addingTimeInterval(-86_400),
                                           metadata: #"{"pageCount":12}"#), now: now)
        #expect(pdf.meta.map(\.text) == ["12 pages", "1d"])
        let reminder = InboxRowText.make(record(type: "reminder", title: "x", created: now.addingTimeInterval(-3 * 86_400),
                                                metadata: #"{"targetType":"task","targetTitle":"Decide on pricing"}"#), now: now)
        #expect(reminder.title == "Decide on pricing")
        #expect(reminder.meta.first == InboxMetaPart(text: "Reminder · Task", accented: true))
        let stale = InboxRowText.make(record(created: now.addingTimeInterval(-9 * 86_400)), now: now)
        #expect(stale.meta.last == InboxMetaPart(text: "9d", accented: true))
    }

    /// Desktop's `canFileItem`: embedding an image needs a linked note.
    @Test func filing_confirms_only_when_it_can_land() {
        #expect(!InboxFileSheet.canConfirm(isImage: true, mode: .embed, linkCount: 0, hasFolder: true))
        #expect(InboxFileSheet.canConfirm(isImage: true, mode: .embed, linkCount: 1, hasFolder: false))
        #expect(InboxFileSheet.canConfirm(isImage: true, mode: .link, linkCount: 0, hasFolder: true))
        #expect(InboxFileSheet.canConfirm(isImage: false, mode: .embed, linkCount: 0, hasFolder: true))
        #expect(!InboxFileSheet.canConfirm(isImage: false, mode: .embed, linkCount: 0, hasFolder: false))
    }

    @Test func a_social_link_names_its_platform() {
        #expect(InboxCopy.viewOn(platform: "twitter") == "View on X")
        #expect(InboxCopy.viewOn(platform: "reddit") == "View on Reddit")
        #expect(InboxCopy.viewOn(platform: "Instagram") == "View on Instagram")
        #expect(InboxCopy.viewOn(platform: "somewhere") == InboxCopy.openPost)
        #expect(InboxCopy.viewOn(platform: nil) == InboxCopy.openPost)
    }

    @Test func rows_group_by_local_day() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        let ms = { (date: Date) in Int64(date.timeIntervalSince1970 * 1000) }
        #expect(InboxPeriod.of(ms(now.addingTimeInterval(-3600)), now: now, calendar: calendar) == .today)
        #expect(InboxPeriod.of(ms(now.addingTimeInterval(-86_400)), now: now, calendar: calendar) == .yesterday)
        #expect(InboxPeriod.of(ms(now.addingTimeInterval(-3 * 86_400)), now: now, calendar: calendar) == .older)
    }

    @Test func snooze_presets_match_desktop() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        // Thursday 12:00: later today = max(15:00, 18:00) = 18:00.
        let later = InboxSnoozePreset.laterToday.date(now: now, calendar: calendar)
        #expect(calendar.component(.hour, from: later) == 18)
        // 16:00 -> 19:00 (three hours beats 18:00).
        let four = now.addingTimeInterval(4 * 3600)
        #expect(calendar.component(.hour, from: InboxSnoozePreset.laterToday.date(now: four, calendar: calendar)) == 19)
        // 19:00 -> 09:00 tomorrow.
        let seven = now.addingTimeInterval(7 * 3600)
        let next = InboxSnoozePreset.laterToday.date(now: seven, calendar: calendar)
        #expect(calendar.component(.hour, from: next) == 9)
        #expect(calendar.component(.day, from: next) == 25)
        #expect(calendar.component(.weekday, from: InboxSnoozePreset.thisWeekend.date(now: now, calendar: calendar)) == 7)
        #expect(calendar.component(.weekday, from: InboxSnoozePreset.nextWeek.date(now: now, calendar: calendar)) == 2)
        #expect(InboxSnoozePreset.inOneHour.date(now: now, calendar: calendar) == now.addingTimeInterval(3600))
    }

    @Test func the_review_nudge_fires_at_its_next_time() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        let today = InboxNotifications.nextFire("18:00", now: now, calendar: calendar)
        #expect(today.map { calendar.component(.day, from: $0) } == 24)
        let tomorrow = InboxNotifications.nextFire("09:00", now: now, calendar: calendar)
        #expect(tomorrow.map { calendar.component(.day, from: $0) } == 25)
    }

    @Test func a_page_head_gives_the_fields_desktop_stores() throws {
        let html = """
        <html><head><title>Fallback &amp; title</title>
        <meta name="description" content="plain">
        <meta property='og:description' content="Small teams &amp; short cycles">
        <meta content="/hero.png" property="og:image">
        <meta property="og:site_name" content="Linear">
        <link rel="shortcut icon" href="/favicon.ico"></head></html>
        """
        let base = try #require(URL(string: "https://linear.app/method"))
        let page = InboxLinkPage.parse(html, base: base)
        #expect(page.title == "Fallback & title")
        #expect(page.description == "Small teams & short cycles")
        #expect(page.heroImage == "https://linear.app/hero.png")
        #expect(page.siteName == "Linear")
        #expect(page.favicon == "https://linear.app/favicon.ico")
        #expect(InboxLinkPage.parse("<p>no head</p>", base: base) == InboxLinkPage())
    }
}

@MainActor
@Suite("Inbox store", .serialized)
struct InboxStoreTests {
    @Test func capture_lists_and_archive_hides_with_undo() async throws {
        let vault = try InboxTestVault()
        let result = await vault.store.capture("[agent] a thought worth keeping")
        guard case let .captured(id) = result else {
            Issue.record("expected a capture, got \(result)")
            return
        }
        #expect(vault.store.items.map(\.id) == [id])
        #expect(vault.store.toast?.message == InboxCopy.itemCaptured)
        let duplicate = await vault.store.capture("[agent] a thought worth keeping")
        if case .duplicate = duplicate {} else { Issue.record("expected the duplicate notice") }
        guard let item = vault.store.items.first else { return }
        await vault.store.archive(item)
        #expect(vault.store.items.isEmpty)
        #expect(vault.store.toast?.undo != nil)
        await vault.store.toast?.undo?()
        #expect(vault.store.items.map(\.id) == [id])
    }

    @Test func the_type_filter_and_the_views() async throws {
        let vault = try InboxTestVault()
        _ = await vault.store.capture("[agent] one note here to keep")
        _ = await vault.store.capture("https://example.com/agent/1")
        #expect(vault.store.count(of: "link") == 1)
        vault.store.toggleType("link")
        #expect(vault.store.visibleItems.map(\.itemType) == ["link"])
        vault.store.typeFilter = []
        guard let note = vault.store.items.first(where: { $0.itemType == "note" }) else { return }
        await vault.store.snooze([note.id], until: Date().addingTimeInterval(3600))
        #expect(vault.store.items.count == 1)
        await vault.store.select(.snoozed)
        #expect(vault.store.panel?.upcoming.count == 1)
        await vault.store.file(note, to: "Agent Test", tags: [])
        await vault.store.select(.insights)
        #expect(vault.store.history.count == 1)
    }

    /// A memo left "pending" by a process that ended mid-transcription is
    /// picked up again: its audio is on this phone. One captured elsewhere
    /// (no local file) stays as it is.
    @Test func a_stranded_transcription_is_resumed() async throws {
        let vault = try InboxTestVault()
        let relative = "attachments/inbox/[agent]-memo/voice-memo.m4a"
        let file = vault.directory.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0, 1, 2]).write(to: file)
        let here = try vault.inbox.captureVoice(
            id: "[agent]-memo", durationSeconds: 3, format: "m4a", size: 3, attachmentPath: relative,
            waveform: [], transcriptionStatus: "pending", captureSource: "inline"
        )
        let elsewhere = try vault.inbox.captureVoice(
            id: "[agent]-remote", durationSeconds: 3, format: "m4a", size: 3,
            attachmentPath: "attachments/inbox/[agent]-remote/voice-memo.m4a",
            waveform: [], transcriptionStatus: "pending", captureSource: "inline"
        )
        await vault.store.refresh()
        await vault.store.resumeTranscriptions()
        #expect(vault.store.item(here.id)?.transcriptionStatus != "pending")
        #expect(vault.store.item(elsewhere.id)?.transcriptionStatus == "pending")
    }

    /// Desktop's limits: a type outside the allow-list and a file over 50 MB
    /// are refused with their own message, and nothing is captured.
    @Test func an_unsupported_or_oversized_file_is_refused() async throws {
        let vault = try InboxTestVault()
        let odd = await vault.store.captureFile(data: Data([1, 2, 3]), filename: "[agent] x.exe", mimeType: "application/x-msdownload")
        if case .failed = odd {} else { Issue.record("expected a refusal, got \(odd)") }
        #expect(vault.store.failure?.code == InboxErrors.unsupportedType.code)
        let big = await vault.store.captureFile(
            data: Data(count: 50 * 1024 * 1024 + 1), filename: "[agent] big.pdf", mimeType: "application/pdf"
        )
        if case .failed = big {} else { Issue.record("expected a refusal, got \(big)") }
        #expect(vault.store.failure?.code == InboxErrors.tooLarge.code)
        #expect(vault.store.items.isEmpty)
    }

    /// A photo whose upload fails stays in the inbox and leaves no empty note
    /// behind: each retry used to add one more "[agent] photo" twin.
    @Test func a_failed_file_upload_leaves_no_empty_note() async throws {
        let scratch = try InboxTestVault()
        let notes = scratch.vault.notes()
        let store = InboxStore(
            core: scratch.inbox, vaultId: "vault-inbox-test", vaultDirectory: scratch.directory,
            filler: UploadRefused(), notes: notes,
            writer: try scratch.vault.notesWriter(store: TaskTestKeychain())
        )
        let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10])
        let result = await store.captureFile(data: bytes, filename: "[agent] photo.jpg", mimeType: "image/jpeg")
        guard case .captured = result, let item = store.items.first else {
            Issue.record("expected a capture, got \(result)")
            return
        }
        await store.file(item, to: "Agent Test", tags: [])
        #expect(store.items.map(\.id) == [item.id])
        #expect(try notes.list().isEmpty)
    }
}

/// A filler whose upload refuses (the shared default), nothing else scripted.
private final class UploadRefused: VaultFilling, @unchecked Sendable {
    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}
