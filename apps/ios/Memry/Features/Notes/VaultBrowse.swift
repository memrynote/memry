import Foundation
import MemryCore
import Observation

// T156, the state half. Reading one opened vault's folders and notes.
//
// **The read half.** Writes (note and folder create, rename, move, delete)
// live in `VaultWrite.swift` behind `NotesWriting`.
//
// **Every core call here blocks** (`contracts/core-api.md`, the read slice):
// they are local SQLite reads plus a `yrs` apply, so they go on `CoreExecutor`
// rather than being awaited directly. Nothing offers a Cancel over one —
// `rust_future_cancel` appears zero times in the bindings (spec-defect 108),
// and a blocking call never had anything to cancel.
//
// **Two crossings per load, and never one per row.** `list()` is a local read
// but still crosses the FFI, and a 94-note vault is a realistic size. The two
// snapshots are folded into a `VaultOutline` once, and every row afterwards is
// a value read.
//
// **Empty, empty-folder and unreadable are three screens, by construction.**
// They are three `Phase` cases with no shared arm, and a read that throws
// cannot reach `.empty` because `.empty` is only assigned where both reads
// returned. A `GET /sync/vaults` reader once `filter_map`-ed a row away and
// told an account holding four vaults it had none; the same shape here would
// tell a user with notes that they have none.
//
// **No note title, id, folder path or body text reaches a log** (Constitution
// II). There is nowhere to put one: `Log` takes a `StaticString` and a closed
// `LogDetail`, so a count is the only thing that can be said.

/// One vault's read-only content surface.
///
/// A two-method dependency rather than `Notes` itself, so a test can script an
/// answer — including a failure — without a database.
protocol NotesReading: Sendable {
    /// - Returns: every configured folder, parent before child. **Empty means
    ///   empty.** A projection that could not be read throws.
    func folders() async throws -> [FolderSummary]
    /// - Returns: every live note, newest first. No folder filter exists on
    ///   the exported surface, which is why the grouping is done here.
    func list() async throws -> [NoteSummary]
    /// One note and its body, for T157's read surface.
    ///
    /// - Returns: `nil` when this vault holds no live note by that id.
    ///   **`nil` is not an error and not an empty note**: a note that exists
    ///   and cannot be read throws, and a note that exists and holds no text
    ///   returns a `NoteBody`. Three answers, three screens.
    func read(id: String) async throws -> NoteDetail?
    /// One note's tags, typed properties and aliases.
    ///
    /// - Returns: `nil` for "no such note", exactly as `read` does. **Empty
    ///   lists are not absence**: a note that carries no tag is a different
    ///   screen from a note that is gone.
    func metadata(id: String) async throws -> NoteMetadata?
    /// What a `[[wiki link]]` points at.
    ///
    /// - Returns: `nil` for a link naming no note. That is a **broken link,
    ///   not a failure** — a link carries a title, so it can name a note that
    ///   does not exist, and the screen says so rather than showing an error.
    func resolveWikiTarget(_ target: String) async throws -> String?
    /// The same note's body as blocks, for rendering rather than previewing.
    ///
    /// - Returns: `nil` for "no such note", exactly as `read` does. An **empty
    ///   array** is a body this device holds that contains nothing — the same
    ///   distinction `NoteBody.present` draws one level down, and the reason
    ///   the two are not collapsed here.
    func blocks(id: String) async throws -> [Block]?
    /// One table's rows, cells and column widths, by the block id
    /// ``blocks(id:)`` reported for the `table` block.
    ///
    /// - Returns: `nil` when there is no such table — no such note, or a
    ///   block id holding something else. A flat block list carries one
    ///   dimension and a table is two, which is why this is a second read
    ///   rather than a field.
    func table(id: String, blockId: String) async throws -> TableContent?
    /// Every attachment this vault knows one note references.
    ///
    /// - Returns: an **empty list is not "this note has no attachments"**. It
    ///   is also what a note whose references have never arrived looks like,
    ///   because an absent `attachmentReferences` means "this sender does not
    ///   know" (chapter 13 §13.4).
    func attachments(id: String) async throws -> [CachedAttachment]
    /// The tasks linked to one note (N807).
    func linkedTasks(noteId: String) async throws -> [LinkedTask]
    /// Every review comment and suggestion on one note (N604). Read only:
    /// §12.5.1 forbids this client writing them.
    func comments(id: String) async throws -> [ReviewComment]
    /// The card a `taskBlock` draws for its task, or `nil` when this vault
    /// does not hold the task.
    func task(id: String) async throws -> TaskCard?
    /// Every template a note can be made from (N803).
    func templates() async throws -> [TemplateSummary]
    /// The reminders pointing at one note (N804).
    func reminders(noteId: String) async throws -> [ReminderSummary]
    /// Every tag in the vault, with its note count (N600).
    func tags() async throws -> [TagSummary]
    /// The live notes carrying one tag (N600). Matched case-insensitively by
    /// the column's own collation, which is ASCII-only and matches desktop.
    func notesTagged(_ tag: String) async throws -> [NoteSummary]
    /// The live journal days carrying one tag, titled by their date, for a
    /// tag view block. Same collation as ``notesTagged(_:)``.
    func journalsTagged(_ tag: String) async throws -> [NoteSummary]
    /// What one body block's `url` points at.
    ///
    /// A block carries a vault-relative path rather than an attachment id, so
    /// the core binds the two by the basename of the signed manifest's
    /// filename. Four answers, because a remote image is ordinary content and
    /// an ambiguous name is refused rather than guessed.
    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment
    /// Desktop's sidebar bookmarks that resolve to something this vault
    /// holds, in the user's order. Read only: the phone does not write them.
    func bookmarks() async throws -> [BookmarkEntry]
}

extension NotesReading {
    /// Readers that are not the vault's own (the journal bridge, test
    /// doubles) hold no bookmarks.
    func bookmarks() async throws -> [BookmarkEntry] { [] }

    /// Test doubles hold no journal.
    func journalsTagged(_ tag: String) async throws -> [NoteSummary] { [] }
}

/// The production reader: the core's own `Notes`, over the shell's one serial
/// core queue.
struct CoreNotesReader: NotesReading {
    private let vault: Vault
    private let executor: CoreExecutor

    init(vault: Vault, executor: CoreExecutor) {
        self.vault = vault
        self.executor = executor
    }

    /// `vault.notes()` is a clone of the same handle rather than a second
    /// connection (`core-api.md`), so taking it inside the queued block costs
    /// nothing and keeps every FFI crossing on the one queue.
    func folders() async throws -> [FolderSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().folders() }
    }

    func list() async throws -> [NoteSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().list() }
    }

    /// Blocking like its siblings — a SQLite read plus a `yrs` apply — so it
    /// goes on the same serial queue and offers no Cancel (spec-defect 108).
    func read(id: String) async throws -> NoteDetail? {
        let vault = vault
        return try await executor.run { try vault.notes().read(id: id) }
    }

    /// Blocking for the same reason and on the same queue. It rebuilds the
    /// **same** document `read` does, from the same update log, so the two
    /// cannot disagree about what has arrived.
    func blocks(id: String) async throws -> [Block]? {
        let vault = vault
        return try await executor.run { try vault.notes().blocks(id: id) }
    }

    /// Same queue, same document, same reasons.
    func table(id: String, blockId: String) async throws -> TableContent? {
        let vault = vault
        return try await executor.run { try vault.notes().table(id: id, blockId: blockId) }
    }

    func attachments(id: String) async throws -> [CachedAttachment] {
        let vault = vault
        return try await executor.run { try vault.notes().attachments(id: id) }
    }

    func comments(id: String) async throws -> [ReviewComment] {
        let vault = vault
        return try await executor.run { try vault.notes().comments(id: id) }
    }

    func task(id: String) async throws -> TaskCard? {
        let vault = vault
        return try await executor.run { try vault.notes().task(taskId: id) }
    }

    func linkedTasks(noteId: String) async throws -> [LinkedTask] {
        let vault = vault
        return try await executor.run { try vault.notes().linkedTasks(noteId: noteId) }
    }

    func templates() async throws -> [TemplateSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().templates() }
    }

    func reminders(noteId: String) async throws -> [ReminderSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().reminders(noteId: noteId) }
    }

    func tags() async throws -> [TagSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().tags() }
    }

    func notesTagged(_ tag: String) async throws -> [NoteSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().notesTagged(tag: tag) }
    }

    func journalsTagged(_ tag: String) async throws -> [NoteSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().journalsTagged(tag: tag) }
    }

    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment {
        let vault = vault
        return try await executor.run {
            try vault.notes().attachmentForBlock(id: id, url: url)
        }
    }

    /// One indexed row plus the vault's property definitions — no CRDT apply,
    /// so it is the cheapest of these reads and still goes on the same queue.
    func metadata(id: String) async throws -> NoteMetadata? {
        let vault = vault
        return try await executor.run { try vault.notes().metadata(id: id) }
    }

    /// A title lookup, then an alias pass. Blocking like its siblings.
    func resolveWikiTarget(_ target: String) async throws -> String? {
        let vault = vault
        return try await executor.run { try vault.notes().resolveWikiTarget(target: target) }
    }

    func bookmarks() async throws -> [BookmarkEntry] {
        let vault = vault
        return try await executor.run { try vault.notes().bookmarks() }
    }
}
