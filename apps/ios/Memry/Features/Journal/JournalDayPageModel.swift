import Foundation
import MemryCore
import Observation

// JP040, JP041. Everything one Day page holds, keyed by its date: the note
// page's view models over a `JournalNoteBridge` for that date. A page owns
// its models and nothing reroutes them, so an edit still pending when the
// user swipes away lands on the day it was typed on (desktop
// `use-journal-entry.ts` flushes to the date it was scheduled for).
//
// Built after the day's first read, so the models carry the day's own
// record id (an existing id wins over `j<date>`, D5).

@MainActor
@Observable
final class JournalDayPageModel {
    let date: String
    let bridge: JournalNoteBridge
    let read: NoteReadViewModel
    let editor: NoteEditorViewModel
    let metadata: NoteMetadataViewModel
    let composer: NoteAttachmentComposer
    let backlinks: BacklinksViewModel
    let linkedTasks: LinkedTasksViewModel
    let taskActions: NoteTaskActions

    /// The last body the page drew, kept while a reload is in flight so the
    /// page does not blank (and drop the caret) on every re-read.
    var lastDetail: NoteDetail?
    /// Find in page (J09) is open over this page.
    var finding = false
    /// The user tapped a disabled ghost row: say why it is disabled.
    var explainsReadOnlyMetadata = false
    private var seedChecked = false

    init(store: JournalStore, date: String, context: JournalVaultContext) {
        self.date = date
        let id = store.cachedDay(date)?.id ?? JournalNoteBridge.newDayId(date)
        let bridge = JournalNoteBridge(store: store, date: date, exposesMetadata: JournalWriteGate.metadataWrites)
        self.bridge = bridge
        read = NoteReadViewModel(
            route: NoteRoute(id: id),
            reader: bridge,
            filler: context.filler,
            reachability: PathReachability.forAttachments
        )
        editor = NoteEditorViewModel(noteId: id, editor: bridge)
        metadata = NoteMetadataViewModel(
            noteId: id,
            writer: JournalWriteGate.metadataWrites ? JournalMetadataWriter(bridge: bridge) : nil
        )
        composer = NoteAttachmentComposer(noteId: id, filler: context.filler)
        backlinks = BacklinksViewModel(noteId: id, search: context.search)
        linkedTasks = LinkedTasksViewModel(noteId: id, reader: bridge)
        taskActions = NoteTaskActions(noteId: id, tasks: context.noteTasks)
    }

    /// Reads the day once, then builds its page. `nil` when the store has no
    /// note-page context (a test store).
    static func make(store: JournalStore, date: String) async -> JournalDayPageModel? {
        guard let context = store.context else { return nil }
        if !store.hasRead(date) { await store.loadDay(date) }
        return JournalDayPageModel(store: store, date: date, context: context)
    }

    /// What the page draws: the current read, or the last one while a
    /// reload is in flight.
    var detail: NoteDetail? {
        if case let .ready(detail) = read.phase { return detail }
        return lastDetail
    }

    /// D2, JP049: the shown day with no entry is seeded from its template
    /// once. Only the shown page asks, so paging past a day never seeds it.
    func seedIfNeeded(store: JournalStore) async {
        guard !seedChecked else { return }
        seedChecked = true
        guard store.hasRead(date), store.cachedDay(date) == nil else { return }
        if await store.seedIfNeeded(date) {
            await store.loadDay(date)
            await read.reload()
        }
    }

    /// Pulls this day's body from the server and re-reads it when anything
    /// arrived. Desktop pushes a body edit as CRDT updates without a record,
    /// so the sync pass (which pulls bodies of records it applied) never
    /// fetches it; a note page does the same on open. Offline or not yet
    /// synced is not an error here: the local body stays on screen.
    func pullRemoteBody(store: JournalStore) async {
        guard let filler = store.context?.filler, store.cachedDay(date) != nil else { return }
        do {
            let summary = try await filler.fetchNoteBody(noteId: read.route.id)
            guard summary.updates > 0 || summary.baselines > 0 else { return }
            // The pulled body may carry new links: index it, then let every
            // page re-read (generation), which also refreshes backlinks.
            await JournalTabContent.reindex(store)
            await store.refresh()
        } catch {
            Log.sync.debug("a journal day body could not be pulled")
        }
    }

    /// The first line typed into an empty day: one paragraph through
    /// `editDay`, which creates the day (D2). The block editor takes over
    /// once the re-read draws the new block.
    @discardableResult
    func writeFirstLine(_ text: String) async -> Bool {
        let edit = BlockEdit.insertParagraph(
            afterBlockId: nil,
            text: text,
            newBlockId: UUID().uuidString.lowercased()
        )
        do {
            _ = try await bridge.edit(noteId: read.route.id, edit)
        } catch {
            Log.storage.error("the first line of a journal day did not land")
            return false
        }
        await read.reload()
        return true
    }
}

/// The pages the Day screen keeps: the shown day and its neighbours, each
/// with its own models. Pages outside the window are dropped.
@MainActor
@Observable
final class JournalDayPages {
    private(set) var models: [String: JournalDayPageModel] = [:]
    private var building: Set<String> = []

    func model(for date: String) -> JournalDayPageModel? { models[date] }

    /// Builds `date`'s page once.
    func build(_ date: String, store: JournalStore) async {
        guard models[date] == nil, !building.contains(date) else { return }
        building.insert(date)
        defer { building.remove(date) }
        if let model = await JournalDayPageModel.make(store: store, date: date) {
            models[date] = model
        }
    }

    /// Keeps only the pages in `window`.
    func keep(_ window: [String]) {
        let keep = Set(window)
        for date in models.keys where !keep.contains(date) {
            models[date] = nil
        }
    }
}
