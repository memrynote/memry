import Foundation
import MemryCore
import Observation

// JP030. The one model every journal screen reads: the open day, the month
// and year a screen shows, the streak, the reminders of the open day and the
// journal settings.
//
// **All rules are the core's** (D4): which days count, a day's level and
// preview, the streak walk, month and year totals, template resolution. The
// store holds view state and asks `Journal` for every answer.
//
// **A day is created by its first write, never by a read** (D2). Every read
// here is a pure read; the writes go through `Journal` methods addressed by
// date, which create or revive the day in the same transaction.
//
// **Writes then sync.** A write is durable locally when the core answers; the
// store re-reads what the write touched and asks the vault for a debounced
// pull-then-push pass (`requestVaultSync`).
//
// Feature screens add operations in `JournalStore+<Feature>.swift`
// extensions built on ``perform(_:_:)`` and ``read(_:)``, so no two screens
// edit this file.

/// D5 and gate G0 (JP029): every shipped desktop empties a day's vault file
/// when a record-only journal write (tags, properties) arrives, so the phone
/// keeps those rows read-only until a desktop release with the fix is out.
/// Body edits, templates and reminders are unaffected. Flip to `true` then.
enum JournalWriteGate {
    static let metadataWrites = false
}

/// The note-page dependencies the day page composes (JP033): a day's body,
/// review comments, attachments and tables are read through the note reader
/// with the day's record id, and a note opened from a day uses the same set.
struct JournalVaultContext {
    let reader: any NotesReading
    let filler: (any VaultFilling)?
    let writer: (any NotesWriting)?
    let editor: (any BlockEditing)?
    let metadataWriter: (any NoteMetadataWriting)?
    let search: (any VaultSearching)?
    let noteTasks: (any NoteTaskWriting)?
}

@MainActor
@Observable
final class JournalStore {
    // MARK: Data

    /// Days read so far, by date. `.some(nil)` is "read, and no entry".
    private(set) var days: [String: JournalDayRecord?] = [:]
    /// The month screens show, by `YYYY-MM`.
    private(set) var months: [String: JournalMonthRecord] = [:]
    /// The year screens show, by year.
    private(set) var years: [Int64: JournalYearRecord] = [:]
    private(set) var streak: JournalStreakRecord?
    /// The open day's reminders, by date.
    private(set) var reminders: [String: [JournalReminder]] = [:]
    private(set) var settings: JournalSettingsRecord?
    /// Bumped after every write or sync, so a screen holding its own copy
    /// (the day page's body) knows to re-read.
    private(set) var generation = 0
    /// Bumped once per finished sync pass. A body edited on another device
    /// moves no record, so the pass pulls no body for it; the shown day
    /// pulls its own on this signal (JP040 external updates).
    private(set) var syncPasses = 0

    // MARK: State

    private(set) var failure: UserFacingError?
    /// A short confirmation a screen shows (e.g. "Reminder set").
    var toast: String?
    /// Free-form state a feature block keeps between screens.
    var scratch: [String: String] = [:]

    // MARK: Dependencies

    let core: any JournalProtocol
    let clock: JournalClock
    let vaultId: String
    private let executor: CoreExecutor
    /// The vault's debounced sync request. Set by the tab; `nil` in tests.
    var requestSync: (@MainActor () -> Void)?
    /// The note page's readers and writers over this vault. Set by the tab;
    /// `nil` in tests that do not render a page.
    @ObservationIgnored var context: JournalVaultContext?

    init(core: any JournalProtocol, clock: JournalClock, vaultId: String, executor: CoreExecutor = .shared) {
        self.core = core
        self.clock = clock
        self.vaultId = vaultId
        self.executor = executor
    }

    var today: String { clock.today }

    // MARK: Reading

    /// Reads one day. Never writes.
    @discardableResult
    func loadDay(_ date: String) async -> JournalDayRecord? {
        let core = core
        do {
            let day = try await executor.run { try core.day(date: date) }
            days[date] = .some(day)
            return day
        } catch {
            report(error)
            return nil
        }
    }

    /// The cached day, `nil` when it has not been read yet or has no entry.
    func cachedDay(_ date: String) -> JournalDayRecord? {
        days[date] ?? nil
    }

    /// Whether `date` has been read (with or without an entry).
    func hasRead(_ date: String) -> Bool {
        days[date] != nil
    }

    /// Reads a month (1-12), newest day first.
    @discardableResult
    func loadMonth(year: Int, month: Int) async -> JournalMonthRecord? {
        let core = core
        let today = today
        do {
            let record = try await executor.run {
                try core.month(year: Int64(year), month: UInt32(month), today: today)
            }
            months[Self.monthKey(year: year, month: month)] = record
            streak = record.streak
            return record
        } catch {
            report(error)
            return nil
        }
    }

    /// Reads a year's twelve cards and totals.
    @discardableResult
    func loadYear(_ year: Int) async -> JournalYearRecord? {
        let core = core
        let today = today
        do {
            let record = try await executor.run { try core.year(year: Int64(year), today: today) }
            years[Int64(year)] = record
            streak = record.streak
            return record
        } catch {
            report(error)
            return nil
        }
    }

    /// The streak counted from the local today (D3).
    func loadStreak() async {
        let core = core
        let today = today
        streak = await read { _ in try core.streak(today: today) }
    }

    /// The day's reminders, every status, by time.
    func loadReminders(_ date: String) async {
        let core = core
        if let list = await read({ _ in try core.reminders(date: date) }) {
            reminders[date] = list
        }
    }

    /// The synced journal template settings.
    func loadSettings() async {
        let core = core
        settings = await read { _ in try core.settings() }
    }

    func month(year: Int, month: Int) -> JournalMonthRecord? {
        months[Self.monthKey(year: year, month: month)]
    }

    static func monthKey(year: Int, month: Int) -> String {
        String(format: "%04d-%02d", year, month)
    }

    /// Re-reads everything a screen has shown (after a sync pass or a write
    /// made elsewhere). Days stay keyed, so an open page updates in place.
    func refresh() async {
        for date in days.keys { await loadDay(date) }
        for key in months.keys {
            let (year, month) = JournalDates.yearMonth(key + "-01")
            await loadMonth(year: year, month: month)
        }
        for year in years.keys { await loadYear(Int(year)) }
        for date in reminders.keys { await loadReminders(date) }
        if settings != nil { await loadSettings() }
        generation += 1
    }

    /// A sync pass finished: re-read what is loaded and tell the shown day.
    func syncFinished() async {
        await refresh()
        syncPasses += 1
    }

    // MARK: Writing

    /// Runs one core write, re-reads `date` and its month, then syncs.
    @discardableResult
    func perform<T: Sendable>(
        date: String?,
        _ work: @escaping @Sendable (any JournalProtocol) throws -> T
    ) async -> T? {
        let core = core
        do {
            let value = try await executor.run { try work(core) }
            failure = nil
            if let date { await afterWrite(date) }
            generation += 1
            requestSync?()
            return value
        } catch {
            report(error)
            return nil
        }
    }

    /// Reads without syncing; a failure is reported and answers `nil`.
    func read<T: Sendable>(_ work: @escaping @Sendable (any JournalProtocol) throws -> T) async -> T? {
        let core = core
        do {
            return try await executor.run { try work(core) }
        } catch {
            report(error)
            return nil
        }
    }

    /// What a write to `date` changes on screen: the day, its month, its year
    /// and the streak, when those were being shown.
    private func afterWrite(_ date: String) async {
        await loadDay(date)
        let (year, month) = JournalDates.yearMonth(date)
        if months[Self.monthKey(year: year, month: month)] != nil {
            await loadMonth(year: year, month: month)
        }
        if years[Int64(year)] != nil { await loadYear(year) }
        if reminders[date] != nil { await loadReminders(date) }
    }

    // MARK: Errors

    func report(_ error: any Error) {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("a journal operation failed", .code(mapped.code))
        if mapped.isUserVisible { failure = mapped }
    }

    func clearFailure() { failure = nil }
}
