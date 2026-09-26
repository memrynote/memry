import Foundation
import MemryCore
import Observation

// Spec 007 CL015/CL023. The one model every calendar screen reads.
//
// **All rules are the core's** (goal D2): what a range contains, colours,
// editability, what a write emits. The store holds view state and a small
// cache of loaded windows, so paging back to a window already loaded draws at
// once and refreshes behind it (goal "Performance").
//
// **Writes then sync.** A write is durable when the core answers; the store
// re-reads every cached window from the core (never patches its copy), then
// runs one debounced pull-then-push pass so desktop sees it.

/// A confirmation with an optional Undo (artboard 16).
struct CalendarToast: Equatable {
    let id = UUID()
    let message: String
    let undo: (@MainActor () async -> Void)?
    static func == (lhs: CalendarToast, rhs: CalendarToast) -> Bool { lhs.id == rhs.id }
}

/// One loaded range.
struct CalendarWindow: Hashable, Sendable {
    let startAt: String
    let endAt: String
}

@MainActor
@Observable
final class CalendarStore {
    // MARK: Data

    private(set) var windows: [CalendarWindow: [CalendarItem]] = [:]
    private(set) var sources: [CalendarSourceRecord] = []
    private(set) var weekStartsOn = 1
    private(set) var showNotesOnCalendar = false
    private(set) var hasLoaded = false
    private(set) var loading: Set<CalendarWindow> = []

    // MARK: State

    var state: CalendarViewState {
        didSet { if state != oldValue { state.save(vaultId: vaultId) } }
    }
    var toast: CalendarToast?
    private(set) var failure: UserFacingError?
    private(set) var isSyncing = false
    /// Bumped when an item sheet should open (search, deep link, create).
    var focus: CalendarFocus?

    // MARK: Dependencies

    let core: any VaultCalendarProtocol
    let vaultId: String
    let filler: (any VaultFilling)?
    /// Task writes (complete, reschedule) and the timeline's task list.
    let tasks: TasksStore?
    private let executor: CoreExecutor
    var clock: @Sendable () -> Date = { Date() }
    private var windowOrder: [CalendarWindow] = []
    private let windowLimit = 6

    init(
        core: any VaultCalendarProtocol,
        vaultId: String,
        filler: (any VaultFilling)?,
        tasks: TasksStore?,
        executor: CoreExecutor = .shared
    ) {
        self.core = core
        self.vaultId = vaultId
        self.filler = filler
        self.tasks = tasks
        self.executor = executor
        state = CalendarViewState.load(vaultId: vaultId)
    }

    // MARK: Derived

    var today: String { CalendarDates.key(clock()) }
    var anchor: String { state.anchorDate ?? today }
    var nowMs: Int64 { Int64(clock().timeIntervalSince1970 * 1000) }

    /// Imported calendars the filter sheet lists (`kind 'calendar'`, not managed).
    var importedSources: [CalendarSourceRecord] {
        sources.filter { $0.kind == "calendar" && !$0.isMemryManaged }
    }

    var selectedImportedSourceIds: [String] {
        CalendarSourceSelection.selected(
            stored: state.importedSourceIds,
            sources: importedSources.map { .init(id: $0.id, isSelected: $0.isSelected) }
        )
    }

    /// `filterItems` (`pages/calendar.tsx`).
    func visible(_ items: [CalendarItem]) -> [CalendarItem] {
        let types = Set(state.visualTypes.map(\.rawValue))
        let selected = Set(selectedImportedSourceIds)
        return items.filter { item in
            guard types.contains(item.visualType) else { return false }
            let imported = item.source.provider != nil && !item.source.isMemryManaged
            if imported {
                guard state.showImportedCalendars else { return false }
                return item.source.calendarSourceId.map(selected.contains) ?? true
            }
            return state.showMemryItems
        }
    }

    func items(in window: CalendarWindow) -> [CalendarItem] {
        visible(windows[window] ?? [])
    }

    // MARK: Reading

    func load() async {
        await refreshSources()
        await refreshAllWindows()
        hasLoaded = true
    }

    /// Loads a window unless it is cached; a cached one refreshes behind.
    func ensure(_ window: CalendarWindow) async {
        if windows[window] == nil { await fetch(window) } else { touch(window) }
    }

    func fetch(_ window: CalendarWindow) async {
        let core = core
        let request = rangeRequest(window)
        let zone = zone(for: window)
        loading.insert(window)
        defer { loading.remove(window) }
        do {
            let items = try await executor.run { try core.range(request: request, zone: zone) }
            // This iPhone's calendars join here, never through the core (D4).
            let local = CalendarEventKitStore.shared.items(
                from: CalendarDates.date(window.startAt) ?? clock(),
                to: CalendarDates.date(window.endAt) ?? clock(),
                zone: zone.identifier
            )
            windows[window] = local.isEmpty ? items : (items + local).sorted { $0.startAt < $1.startAt }
            touch(window)
            failure = nil
        } catch {
            report(error)
        }
    }

    func refreshAllWindows() async {
        for window in windowOrder { await fetch(window) }
    }

    func refreshSources() async {
        let core = core
        do {
            let loaded = try await executor.run {
                (
                    try core.sources(),
                    try core.setting(path: "calendar.weekStartDay"),
                    try core.setting(path: "calendar.showNotesOnCalendar")
                )
            }
            sources = loaded.0
            weekStartsOn = loaded.1 == "\"sunday\"" ? 0 : 1
            showNotesOnCalendar = loaded.2 == "true"
        } catch {
            report(error)
        }
    }

    func search(_ query: String) async -> [CalendarItem] {
        let core = core
        let now = clock()
        let year = CalendarDates.calendar.component(.year, from: now)
        let start = CalendarDates.calendar.date(from: DateComponents(year: year - 2, month: 1, day: 1)) ?? now
        let end = CalendarDates.calendar.date(from: DateComponents(year: year + 3, month: 1, day: 1)) ?? now
        let window = CalendarWindow(startAt: CalendarDates.iso(start), endAt: CalendarDates.iso(end))
        let request = rangeRequest(window, includeUnselected: true)
        let zone = zone(for: window)
        let nowMs = nowMs
        return await read { try core.search(query: query, request: request, zone: zone, nowMs: nowMs) } ?? []
    }

    func rangeRequest(_ window: CalendarWindow, includeUnselected: Bool = true) -> CalendarRangeRequest {
        // Desktop's page asks with `includeUnselectedSources: true` and filters
        // by its own selection (`filterItems`).
        CalendarRangeRequest(
            startAt: window.startAt,
            endAt: window.endAt,
            includeUnselectedSources: includeUnselected,
            enabledPropertyNames: state.calendarProperties,
            showNotesByCreated: showNotesOnCalendar
        )
    }

    private func zone(for window: CalendarWindow) -> CalendarZone {
        CalendarDates.zone(
            from: CalendarDates.date(window.startAt) ?? clock(),
            to: CalendarDates.date(window.endAt) ?? clock()
        )
    }

    private func touch(_ window: CalendarWindow) {
        windowOrder.removeAll { $0 == window }
        windowOrder.append(window)
        while windowOrder.count > windowLimit {
            windows[windowOrder.removeFirst()] = nil
        }
    }

    // MARK: Core access

    func read<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async -> T? {
        do {
            return try await executor.run(work)
        } catch {
            report(error)
            return nil
        }
    }

    /// A write, then every cached window and the sources re-read, then a sync.
    @discardableResult
    func write<T: Sendable>(_ work: @escaping @Sendable (any VaultCalendarProtocol) throws -> T) async -> T? {
        let core = core
        do {
            let value = try await executor.run { try work(core) }
            failure = nil
            await refreshSources()
            await refreshAllWindows()
            scheduleSync()
            return value
        } catch {
            report(error)
            return nil
        }
    }

    func showToast(_ message: String, undo: (@MainActor () async -> Void)? = nil) {
        toast = CalendarToast(message: message, undo: undo)
    }

    // MARK: Sync

    private var syncTask: Task<Void, Never>?

    func scheduleSync() {
        guard filler != nil else { return }
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// Pull then push now (pull to refresh, the filter sheet's refresh).
    func sync() async {
        guard let filler, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let pass = try await filler.syncNow()
            Log.sync.info("calendar sync pass pulled", .count(Int(pass.pulled)))
            Log.sync.info("calendar sync pass pushed", .count(Int(pass.pushed)))
        } catch {
            report(error)
        }
        await refreshSources()
        await refreshAllWindows()
    }

    // MARK: Errors

    func report(_ error: any Error) {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("a calendar operation failed", .code(mapped.code))
        if mapped.isUserVisible { failure = mapped }
    }

    func fail(_ error: UserFacingError) { failure = error }
    func clearFailure() { failure = nil }
}

/// An item sheet to open (search result, deep link, a created event).
struct CalendarFocus: Equatable, Identifiable {
    let id = UUID()
    let date: String
    let projectionId: String?
    let sourceType: String?
    let sourceId: String?
}
