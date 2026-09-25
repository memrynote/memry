import Foundation
import MemryCore

// JP049, template seeding (D2, D10). Opening an empty day whose date resolves
// to a template fills it from that template once.
//
// **Never twice.** The core refuses to seed a day with a live entry
// (`SeedOutcome.alreadyExists`), which is also what a day seeded on another
// device answers. A seeded or already-existing `date:templateId` is not tried
// again this session, like desktop's `templateSeedKeyRef`
// (`hooks/use-journal-entry.ts`).
//
// **A template that has not arrived yet retries, not in a loop.** Settings
// can sync before the template they name, so the core's `NotFound` is a
// transient miss: nothing is written, no error is shown, and the miss is
// remembered with the store's `generation`. The same `date:templateId` is
// tried again only once the generation has moved (a sync pass or another
// write), so re-opening the page or a later sync retries while a screen that
// re-asks on every render does not.
//
// **Why the attempt is a read.** `perform(date:)` bumps the generation and
// requests a sync, and every sync pass bumps it again on refresh, so running
// a miss through it would make miss -> sync -> refresh -> retry a loop. The
// attempt runs through `read` with `NotFound` caught in the closure; only a
// real seed then goes through `perform` so the store re-reads the day, bumps
// the generation and syncs.

/// A `date:templateId` attempt's state, kept in `JournalStore.scratch`
/// (desktop keeps the same in `templateSeedKeyRef` / `templateSeedInFlightRef`).
enum JournalSeedAttempt: Equatable {
    case inFlight
    /// Seeded, or found already existing. Never tried again this session.
    case done
    /// The template was not here at this generation.
    case missed(generation: Int)

    static func key(date: String, templateId: String) -> String {
        "journal.seed.\(date):\(templateId)"
    }

    init?(scratch value: String?) {
        guard let value else { return nil }
        switch value {
        case "inFlight": self = .inFlight
        case "done": self = .done
        default:
            guard value.hasPrefix("missed:"), let generation = Int(value.dropFirst("missed:".count)) else {
                return nil
            }
            self = .missed(generation: generation)
        }
    }

    var scratchValue: String {
        switch self {
        case .inFlight: "inFlight"
        case .done: "done"
        case let .missed(generation): "missed:\(generation)"
        }
    }

    /// Whether a new attempt may start at `generation`.
    static func mayAttempt(_ previous: JournalSeedAttempt?, generation: Int) -> Bool {
        switch previous {
        case nil: true
        case .inFlight, .done: false
        case let .missed(missedAt): missedAt != generation
        }
    }
}

/// What one seed attempt answered.
private enum JournalSeedResult: Sendable {
    case outcome(SeedOutcome)
    case templateMissing
}

extension JournalStore {
    /// Seeds an empty `date` from its template once. `true` when the day now
    /// exists because of this call.
    func seedIfNeeded(_ date: String) async -> Bool {
        // No live entry (D2: this read creates nothing) and a template.
        let resolved = await read { core -> String? in
            guard try core.entryId(date: date) == nil else { return nil }
            return try core.templateFor(date: date)
        }
        guard let resolved, let templateId = resolved else { return false }

        let key = JournalSeedAttempt.key(date: date, templateId: templateId)
        guard JournalSeedAttempt.mayAttempt(JournalSeedAttempt(scratch: scratch[key]), generation: generation),
              let strings = JournalSeedStrings.make(date: date, now: clock.instant())
        else { return false }
        scratch[key] = JournalSeedAttempt.inFlight.scratchValue

        let result = await read { core -> JournalSeedResult in
            do {
                return try .outcome(core.seedFromTemplate(date: date, templateId: templateId, strings: strings))
            } catch StorageError.NotFound {
                return .templateMissing
            }
        }

        switch result {
        case .outcome(.seeded), .outcome(.revived):
            scratch[key] = JournalSeedAttempt.done.scratchValue
            // The write is done; this re-reads the day, bumps the generation
            // and requests the sync.
            await perform(date: date) { _ in }
            return true
        case .outcome(.alreadyExists):
            scratch[key] = JournalSeedAttempt.done.scratchValue
            await loadDay(date)
            return false
        case .templateMissing:
            Log.core.info("a journal template is not on this device yet")
            scratch[key] = JournalSeedAttempt.missed(generation: generation).scratchValue
            return false
        case nil:
            // A failure `read` already reported. It retries like a miss, as
            // desktop leaves its latch unset on an error.
            scratch[key] = JournalSeedAttempt.missed(generation: generation).scratchValue
            return false
        }
    }
}
