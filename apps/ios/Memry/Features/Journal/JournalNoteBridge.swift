import Foundation
import MemryCore

// JP040, JP045. A journal day seen through the note page's seams, so the Day
// page composes `NotePageContent` rather than forking it (JP033).
//
// **Read.** A day is a note with a date for a title: `read(id:)` synthesises
// the `NoteDetail` from the day's record (title = the date, the body state
// from `JournalBody`), and `metadata(id:)` its tags and properties (`date`
// already excluded by the core, and filtered again here). A day with no
// entry reads as a present, empty body, so the page offers the placeholder
// line; nothing is created by reading it (D2). Blocks, tables, comments,
// attachments and linked tasks go to the note reader with the day's record
// id, which the core accepts for a journal (JP027).
//
// **Write.** Every body edit goes through `Journal.editDay` by date, through
// the store, so the first edit creates the day (D2) and every edit re-reads
// and asks for a sync. The date is fixed per bridge: a page's pending edit
// lands on the day it was typed on, never the one shown after a swipe.
//
// **Metadata writes** exist only behind `JournalWriteGate.metadataWrites`
// (D5, gate G0); the page passes no writer while the gate is off.

struct JournalNoteBridge: NotesReading, BlockEditing {
    let store: JournalStore
    let date: String
    /// `false` hides the tags and properties from the note page, for a page
    /// that draws its own read-only rows (the gate is off).
    let exposesMetadata: Bool
    private let reader: (any NotesReading)?

    @MainActor
    init(store: JournalStore, date: String, exposesMetadata: Bool = true) {
        self.store = store
        self.date = date
        self.exposesMetadata = exposesMetadata
        reader = store.context?.reader
    }

    /// The id a new day gets (`domain/journal.rs` `document_id_for`); an
    /// existing record's id always wins (D5).
    static func newDayId(_ date: String) -> String { "j\(date)" }

    // MARK: Synthesis (pure)

    /// The day as the note page reads a note.
    static func detail(date: String, day: JournalDayRecord?, text: String) -> NoteDetail {
        let summary = NoteSummary(
            id: day?.id ?? newDayId(date),
            title: date,
            folderPath: nil,
            emoji: nil,
            createdAt: day?.createdAt,
            modifiedAt: day?.modifiedAt
        )
        let present: Bool = switch day?.body {
        case .notPulled: false
        default: true
        }
        return NoteDetail(summary: summary, body: NoteBody(text: present ? text : "", present: present))
    }

    /// The day's tags and properties; a day with no entry carries none.
    static func metadata(_ day: JournalDayRecord?) -> NoteMetadata {
        NoteMetadata(
            tags: day?.tags ?? [],
            properties: (day?.properties ?? []).filter { $0.name.lowercased() != "date" },
            aliases: [],
            icon: nil,
            coverJson: nil
        )
    }

    /// Plain text of a block list, one block per line (what find and export
    /// read; the core's `extract_text` is not exported for a journal id).
    static func text(of blocks: [Block]) -> String {
        blocks.map { $0.inline.map(\.text).joined() }.joined(separator: "\n")
    }

    // MARK: NotesReading

    func read(id: String) async throws -> NoteDetail? {
        let date = date
        let outcome = await store.read { core in Result { try core.day(date: date) } }
        guard let outcome else { return nil }
        let day = try outcome.get()
        var text = ""
        if let day, day.body == .present, let reader {
            // A walk that fails throws, so the page says so rather than
            // offering the placeholder over a body it could not read.
            text = try Self.text(of: await reader.blocks(id: day.id) ?? [])
        }
        return Self.detail(date: date, day: day, text: text)
    }

    func metadata(id: String) async throws -> NoteMetadata? {
        guard exposesMetadata else { return Self.metadata(nil) }
        let date = date
        let outcome = await store.read { core in Result { try core.day(date: date) } }
        guard let outcome else { return nil }
        return Self.metadata(try outcome.get())
    }

    /// The record id to hand the note reader: the day's own once it exists.
    private func dayId(_ fallback: String) async -> String {
        await store.cachedDay(date)?.id ?? fallback
    }

    func folders() async throws -> [FolderSummary] { try await reader?.folders() ?? [] }
    func list() async throws -> [NoteSummary] { try await reader?.list() ?? [] }

    func resolveWikiTarget(_ target: String) async throws -> String? {
        try await reader?.resolveWikiTarget(target)
    }

    func blocks(id: String) async throws -> [Block]? {
        try await reader?.blocks(id: await dayId(id))
    }

    func table(id: String, blockId: String) async throws -> TableContent? {
        try await reader?.table(id: await dayId(id), blockId: blockId)
    }

    func attachments(id: String) async throws -> [CachedAttachment] {
        try await reader?.attachments(id: await dayId(id)) ?? []
    }

    func linkedTasks(noteId: String) async throws -> [LinkedTask] {
        try await reader?.linkedTasks(noteId: await dayId(noteId)) ?? []
    }

    func comments(id: String) async throws -> [ReviewComment] {
        try await reader?.comments(id: await dayId(id)) ?? []
    }

    func task(id: String) async throws -> TaskCard? { try await reader?.task(id: id) }
    func templates() async throws -> [TemplateSummary] { try await reader?.templates() ?? [] }

    /// A day's reminders live on the bell (JP046), not in the note section.
    func reminders(noteId: String) async throws -> [ReminderSummary] { [] }

    func tags() async throws -> [TagSummary] { try await reader?.tags() ?? [] }

    func notesTagged(_ tag: String) async throws -> [NoteSummary] {
        try await reader?.notesTagged(tag) ?? []
    }

    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment {
        guard let reader else { return .unknown }
        return try await reader.attachmentForBlock(id: await dayId(id), url: url)
    }

    // MARK: BlockEditing

    /// Applies one edit to this bridge's date. The first edit creates the
    /// day (D2). Always `true` when it lands: the core creates or revives
    /// the day rather than answering "no such note".
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        let date = date
        _ = try await write { core in try core.editDay(date: date, edit: edit) }
        return true
    }

    /// Runs one write through `JournalStore.perform`, keeping the core's own
    /// error so the editor maps it (`ErrorMapping`) instead of a stand-in.
    @discardableResult
    func write<T: Sendable>(_ work: @escaping @Sendable (any JournalProtocol) throws -> T) async throws -> T {
        let outcome = await store.perform(date: date) { core in Result { try work(core) } }
        // `perform` answers `nil` only when its closure throws, and this one
        // never does: the core's error travels inside the `Result`.
        guard let outcome else { throw CancellationError() }
        switch outcome {
        case let .success(value):
            return value
        case let .failure(error):
            await store.report(error)
            throw error
        }
    }
}

/// Tags and properties written by date (JP045), used only while
/// `JournalWriteGate.metadataWrites` is on. A day has no title, icon, cover
/// or aliases, so those writes do nothing.
struct JournalMetadataWriter: NoteMetadataWriting {
    let bridge: JournalNoteBridge

    func rename(id: String, title: String) async throws {}
    func setIcon(id: String, icon: String?) async throws {}
    func setCover(id: String, url: String?, offsetY: Double) async throws {}
    func setAliases(id: String, aliases: [String]) async throws {}

    func setTags(id: String, tags: [String]) async throws {
        let date = bridge.date
        try await bridge.write { core in try core.setTags(date: date, tags: tags) }
    }

    func setProperty(id: String, name: String, valueJson: String) async throws {
        let date = bridge.date
        try await bridge.write { core in try core.setProperty(date: date, name: name, valueJson: valueJson) }
    }

    func clearProperty(id: String, name: String) async throws {
        let date = bridge.date
        try await bridge.write { core in try core.clearProperty(date: date, name: name) }
    }
}
