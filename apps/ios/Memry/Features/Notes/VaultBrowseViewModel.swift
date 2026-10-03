import Foundation
import MemryCore
import Observation

@MainActor
@Observable
final class VaultBrowseViewModel {
    /// Where the screen is. Four cases, and the two that mean "nothing to
    /// show" are deliberately not one: a vault that holds nothing is a fact,
    /// a vault that would not read is a failure.
    enum Phase: Equatable {
        case loading
        case ready(VaultOutline)
        /// Both reads succeeded and both were empty.
        case empty
        /// A read threw. **Never rendered as an empty vault.**
        case unreadable(UserFacingError)
    }

    private(set) var phase: Phase = .loading

    /// The reader in use. Internal so the wiring suite can assert that the
    /// production graph holds the **core** reader rather than something that
    /// behaves like it — five tiers shipped in Phase 3 fully tested behind
    /// fakes and never called.
    let reader: any NotesReading

    /// T237. The on-demand body fetch, handed down to `NoteReadView`.
    ///
    /// `nil` when this screen has no session to pull through. A note outside
    /// the first sync's thirty-day body window then stays unreadable, which is
    /// honest — the alternative is a button that cannot do anything.
    let filler: (any VaultFilling)?

    /// The write surface, or `nil` for a screen that has none.
    ///
    /// `nil` is not a policy either: a caller with no keychain to derive this
    /// device's identity from cannot write, and the affordances are hidden
    /// rather than shown failing. See `VaultWrite.swift`.
    let writer: (any NotesWriting)?
    /// The body write surface, `nil` on a vault with no identity to sign
    /// with — the same condition that leaves ``writer`` absent.
    let editor: (any BlockEditing)?
    /// The metadata write surface (title, icon, tags, properties, aliases).
    /// `nil` on a vault with no identity to sign with, like ``writer``.
    let metadataWriter: (any NoteMetadataWriting)?

    /// Full-text search over this vault, or `nil` when the index could be
    /// neither opened nor rebuilt.
    ///
    /// `nil` does not fail the screen: browsing a vault whose index is broken
    /// still works, and the search field falls back to matching titles in the
    /// outline this screen already holds.
    let search: VaultSearchViewModel?
    /// The raw search surface, for the reads that are not a query — the
    /// backlinks section (N800) is one.
    let searcher: (any VaultSearching)?
    /// The task writes a note screen makes (TP054), `nil` without an
    /// identity to sign with, like ``writer``.
    let noteTasks: (any NoteTaskWriting)?

    /// The last failed write, for the screen to show and dismiss. Separate
    /// from ``phase`` because a failed write leaves the vault readable: the
    /// outline is still true, only the write did not happen.
    var writeFailure: UserFacingError?

    /// The root's Bookmarks and Tags sections. Secondary to the outline: a
    /// failed read leaves them as they were rather than failing the screen.
    private(set) var bookmarks: [BookmarkEntry] = []
    private(set) var tags: [TagSummary] = []

    private var hasLoaded = false

    init(
        reader: any NotesReading,
        filler: (any VaultFilling)? = nil,
        writer: (any NotesWriting)? = nil,
        editor: (any BlockEditing)? = nil,
        metadataWriter: (any NoteMetadataWriting)? = nil,
        search: (any VaultSearching)? = nil,
        noteTasks: (any NoteTaskWriting)? = nil
    ) {
        self.reader = reader
        self.noteTasks = noteTasks
        self.filler = filler
        self.writer = writer
        self.editor = editor
        self.metadataWriter = metadataWriter
        self.searcher = search
        self.search = search.map { VaultSearchViewModel(search: $0) }
    }

    /// The production initializer. `AuthRootView` -> `VaultListView` ->
    /// `VaultFillView` -> `NotesListView` reaches this and nothing else.
    convenience init(
        vault: Vault,
        executor: CoreExecutor,
        filler: (any VaultFilling)? = nil,
        store: (any SecureStore)? = nil
    ) {
        self.init(
            reader: CoreNotesReader(vault: vault, executor: executor),
            filler: filler,
            // No store, no identity, no writes — and no buttons offering them.
            writer: store.map { CoreNotesWriter(vault: vault, store: $0, executor: executor) },
            editor: store.map { CoreBlockEditor(vault: vault, store: $0, executor: executor) },
            metadataWriter: store.map {
                CoreNoteMetadataWriter(vault: vault, store: $0, executor: executor)
            },
            // A vault whose index will not open is still a vault worth
            // browsing, so this failure is absorbed into "no full-text search"
            // rather than into "no screen".
            search: try? CoreVaultSearch(vault: vault, executor: executor),
            noteTasks: store.map { CoreNoteTasks(vault: vault, store: $0, executor: executor) }
        )
    }

    /// The loaded hierarchy, or `nil` in every other phase.
    ///
    /// A pure read of the snapshot: route resolution uses it, so a restored
    /// navigation path resolves without a row existing.
    var outline: VaultOutline? {
        guard case let .ready(outline) = phase else { return nil }
        return outline
    }

    /// Loads once per screen. `.task` fires again whenever the view is
    /// re-identified, and re-reading the whole vault each time would be two
    /// FFI crossings for a screen that already has its answer.
    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        await load()
    }

    /// What the retry button calls.
    func reload() async {
        await load()
    }

    /// Re-reads a loaded outline when the list comes back on screen, so a note
    /// made elsewhere (the Inbox files into folders) shows without a relaunch.
    /// Quiet: no loading phase, and a failed read keeps the outline it had.
    func refresh() async {
        guard case .ready = phase else { return }
        guard let folders = try? await reader.folders(), let notes = try? await reader.list() else { return }
        phase = folders.isEmpty && notes.isEmpty ? .empty : .ready(.build(folders: folders, notes: notes))
        await loadShortcuts()
    }

    private func loadShortcuts() async {
        do {
            bookmarks = try await reader.bookmarks()
            tags = try await reader.tags()
        } catch {
            Log.storage.error("this vault's bookmarks or tags could not be read", .code(ErrorMapping.userFacing(error).code))
        }
    }

    private func load() async {
        hasLoaded = true
        phase = .loading
        let folders: [FolderSummary]
        let notes: [NoteSummary]
        do {
            folders = try await reader.folders()
            notes = try await reader.list()
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this vault's folders and notes could not be read", .code(mapped.code))
            // Retryable, so the next attempt is a real attempt.
            hasLoaded = false
            // **Not** `.empty`. The vault may hold ninety-four notes.
            phase = .unreadable(mapped)
            return
        }
        Log.storage.info("read a vault outline", .count(notes.count))
        guard !folders.isEmpty || !notes.isEmpty else {
            phase = .empty
            return
        }
        phase = .ready(.build(folders: folders, notes: notes))
        await loadShortcuts()
    }
}
