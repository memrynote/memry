import Foundation
import MemryCore
import Observation

// IB030. The one model every inbox screen reads: the active captures, their
// counts and stats, the other views (Snoozed & reminders, Archived,
// Insights), the session's view and type filter, and the toast.
//
// **All rules are the core's** (spec 006 D2, D5 of spec 004): which rows are
// active, duplicates, stats, what filing writes. The store holds UI state.
//
// **Writes then sync.** A write is durable locally when the core answers; the
// store re-reads from the core (never patches its copy), then runs one
// debounced pull-then-push pass so the change reaches desktop. An archive
// removes the row at once (`hidden`) and puts it back if the write fails,
// desktop's `archiveWithAnimation`.
//
// Screens add operations in `InboxStore+<Feature>.swift` extensions built on
// ``write(_:_:)``.

/// The four places the title menu switches between (00 audit row 1).
enum InboxView: String, CaseIterable, Identifiable, Sendable {
    case inbox, snoozed, archived, insights
    var id: String { rawValue }
}

/// A confirmation with an optional Undo (Paper 17).
struct InboxToast: Equatable {
    let id = UUID()
    let message: String
    let undo: (@MainActor () async -> Void)?

    static func == (lhs: InboxToast, rhs: InboxToast) -> Bool { lhs.id == rhs.id }
}

@MainActor
@Observable
final class InboxStore {
    // MARK: Data

    private(set) var items: [InboxItemRecord] = []
    private(set) var typeCounts: [InboxTypeCount] = []
    private(set) var stats: InboxStatsRecord?
    private(set) var recentFolders: [String] = []
    private(set) var archivedItems: [InboxItemRecord] = []
    private(set) var panel: InboxPanelRecord?
    private(set) var patterns: InboxPatternRecord?
    private(set) var history: [InboxItemRecord] = []
    private(set) var hasLoaded = false

    // MARK: Session state (00 audit: "Filter state stays per session")

    var view: InboxView = .inbox
    var typeFilter: Set<String> = []
    var archivedSearch = ""
    /// Rows removed optimistically while their write is in flight.
    private(set) var hidden: Set<String> = []
    /// Rows captured in this session, for the fresh-capture fade.
    private(set) var fresh: Set<String> = []
    var toast: InboxToast?
    private(set) var failure: UserFacingError?
    private(set) var isSyncing = false
    @ObservationIgnored private var notificationTask: Task<Void, Never>?
    /// Voice memos being transcribed in this process.
    @ObservationIgnored var transcribing: Set<String> = []

    // MARK: Dependencies

    let core: any InboxProtocol
    let vaultId: String
    /// `<Application Support>/<bundle>/vault/<vaultId>`, where
    /// `attachments/inbox/{id}/` files live.
    let vaultDirectory: URL?
    let filler: (any VaultFilling)?
    /// Folders, notes and tags for the File sheet.
    let notes: (any NotesProtocol)?
    /// Note writes for filing a file capture (the block that shows it).
    let writer: (any NotesWriterProtocol)?
    /// Projects and task reminders for Convert → Task.
    let tasks: (any TasksProtocol)?
    private let executor: CoreExecutor
    var clock: @Sendable () -> Date = { Date() }
    /// Desktop's default `inbox.staleThresholdDays` (§6 IB013).
    let staleDays: Int64 = 7

    init(
        core: any InboxProtocol,
        vaultId: String,
        vaultDirectory: URL?,
        filler: (any VaultFilling)?,
        notes: (any NotesProtocol)? = nil,
        writer: (any NotesWriterProtocol)? = nil,
        tasks: (any TasksProtocol)? = nil,
        executor: CoreExecutor = .shared
    ) {
        self.core = core
        self.vaultId = vaultId
        self.vaultDirectory = vaultDirectory
        self.filler = filler
        self.notes = notes
        self.writer = writer
        self.tasks = tasks
        self.executor = executor
    }

    /// Runs other core work (notes) on the core queue.
    func executorRun<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await executor.run(work)
    }

    // MARK: Derived

    /// The list the Inbox view draws: active rows, the type filter applied.
    var visibleItems: [InboxItemRecord] {
        items.filter { !hidden.contains($0.id) && (typeFilter.isEmpty || typeFilter.contains($0.itemType)) }
    }

    func count(of type: String) -> Int64 {
        typeCounts.first { $0.itemType == type }?.count ?? 0
    }

    /// Captures still to process (the More row and the subtitle).
    var toProcess: Int { items.filter { !hidden.contains($0.id) }.count }

    var nowMs: Int64 { Int64(clock().timeIntervalSince1970 * 1000) }

    /// A file this device holds, or `nil` (inbox files do not sync, §5 F3).
    func localFile(_ relativePath: String?) -> URL? {
        guard let relativePath, let vaultDirectory else { return nil }
        let url = vaultDirectory.appendingPathComponent(relativePath)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: Reading

    /// Snooze-due captures come back first (desktop's minute scheduler), then
    /// everything the current view reads.
    func load() async {
        await resurfaceDue()
        await refresh()
        let first = !hasLoaded
        hasLoaded = true
        if first { Task { await resumeTranscriptions() } }
    }

    /// A memo left `pending` by a process that ended mid-transcription (the
    /// app was closed, or crashed) would say "Transcribing..." forever. Its
    /// audio is on this phone, so the job starts again. A memo captured on
    /// another device has no local file here and is left to that device.
    func resumeTranscriptions() async {
        let stranded = items.filter {
            $0.itemType == "voice" && $0.transcriptionStatus == "pending"
                && !transcribing.contains($0.id) && localFile($0.attachmentPath) != nil
        }
        for item in stranded {
            await transcribeVoice(item.id)
        }
    }

    func refresh() async {
        let core = core
        let now = nowMs
        let stale = staleDays
        let view = view
        let search = archivedSearch
        do {
            let loaded = try await executor.run {
                (
                    try core.list(includeSnoozed: false),
                    try core.typeCounts(),
                    try core.stats(nowMs: now, staleDays: stale),
                    try core.recentFolders(limit: 5)
                )
            }
            items = loaded.0
            typeCounts = loaded.1
            stats = loaded.2
            recentFolders = loaded.3
            switch view {
            case .inbox:
                break
            case .snoozed:
                panel = try await executor.run { try core.panel(nowMs: now) }
            case .archived:
                archivedItems = try await executor.run {
                    try core.archived(search: search.isEmpty ? nil : search, limit: 200, offset: 0)
                }
            case .insights:
                let insight = try await executor.run {
                    (try core.patterns(nowMs: now), try core.filingHistory(limit: 6))
                }
                patterns = insight.0
                history = insight.1
            }
            failure = nil
            scheduleNotifications()
        } catch {
            report(error)
        }
    }

    private func scheduleNotifications() {
        notificationTask?.cancel()
        notificationTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self else { return }
            await InboxNotifications.refresh(store: self)
        }
    }

    func select(_ newView: InboxView) async {
        view = newView
        await refresh()
    }

    func toggleType(_ type: String) {
        if typeFilter.contains(type) { typeFilter.remove(type) } else { typeFilter.insert(type) }
    }

    func item(_ id: String) -> InboxItemRecord? {
        items.first { $0.id == id } ?? archivedItems.first { $0.id == id }
    }

    /// One capture straight from the core (details of snoozed, archived or
    /// filed captures, which the list does not hold).
    func fetch(_ id: String) async -> InboxItemRecord? {
        let core = core
        return await read { _ in try core.get(id: id) } ?? nil
    }

    // MARK: Writing

    /// Runs one core write, re-reads, then syncs.
    @discardableResult
    func write<T: Sendable>(_ work: @escaping @Sendable (any InboxProtocol) throws -> T) async -> T? {
        let core = core
        do {
            let value = try await executor.run { try work(core) }
            failure = nil
            await refresh()
            scheduleSync()
            return value
        } catch {
            report(error)
            return nil
        }
    }

    /// Reads without refreshing or syncing.
    func read<T: Sendable>(_ work: @escaping @Sendable (any InboxProtocol) throws -> T) async -> T? {
        let core = core
        do {
            return try await executor.run { try work(core) }
        } catch {
            report(error)
            return nil
        }
    }

    /// Hides rows now, runs the write, and shows them again if it failed.
    @discardableResult
    func writeRemoving<T: Sendable>(
        _ ids: [String],
        _ work: @escaping @Sendable (any InboxProtocol) throws -> T
    ) async -> T? {
        hidden.formUnion(ids)
        let value = await write(work)
        hidden.subtract(ids)
        return value
    }

    func markFresh(_ id: String) { fresh.insert(id) }

    /// The snooze scheduler's pass (desktop runs it every minute).
    func resurfaceDue() async {
        let core = core
        let back = await read { _ in try core.resurfaceDue() } ?? []
        if !back.isEmpty { scheduleSync() }
    }

    func showToast(_ message: String, undo: (@MainActor () async -> Void)? = nil) {
        toast = InboxToast(message: message, undo: undo)
    }

    // MARK: Sync

    private var syncTask: Task<Void, Never>?

    /// One pull-then-push pass, coalesced: writes in quick succession share it.
    func scheduleSync() {
        guard filler != nil else { return }
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// Pull then push now (pull to refresh, foreground).
    func sync() async {
        guard let filler, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let pass = try await filler.syncNow()
            Log.sync.info("inbox sync pass pulled", .count(Int(pass.pulled)))
            Log.sync.info("inbox sync pass pushed", .count(Int(pass.pushed)))
        } catch {
            report(error)
        }
        await resurfaceDue()
        await refresh()
    }

    // MARK: Errors

    func report(_ error: any Error) {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("an inbox operation failed", .code(mapped.code))
        if mapped.isUserVisible { failure = mapped }
    }

    func fail(_ error: UserFacingError) { failure = error }
    func clearFailure() { failure = nil }

    /// The shell's local wall clock as filing takes it, `YYYY-MM-DDTHH:MM`.
    func localNow() -> String {
        String(TaskDates.localInstant(clock()).prefix(16))
    }
}
