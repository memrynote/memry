import Foundation
import Synchronization

// Note and journal edit events, throttled per document as desktop's
// `shouldEmitThrottled` does (`apps/desktop/src/main/telemetry/throttle.ts`):
// one `note_updated` per note and one `journal_updated` per day per five
// minutes, so typing counts as usage without an event per keystroke. The
// document id or date only keys the throttle; the event carries neither.
enum NotesTelemetry {
    private static let window: TimeInterval = 5 * 60
    private static let maxKeys = 1000
    private static let lastEmitted = Mutex<[String: Date]>([:])

    static func shouldEmit(_ key: String, now: Date = Date()) -> Bool {
        lastEmitted.withLock { seen in
            if let last = seen[key], now.timeIntervalSince(last) < window { return false }
            seen[key] = now
            if seen.count > maxKeys {
                seen = seen.filter { now.timeIntervalSince($0.value) < window }
                if seen.count > maxKeys { seen = [key: now] }
            }
            return true
        }
    }

    static func noteUpdated(_ noteId: String, source: StaticString? = nil) {
        guard shouldEmit("note_updated:\(noteId)") else { return }
        Telemetry.shared.track(.noteUpdated, surface: .notes, action: "updated", objectType: "note", source: source, result: .success)
    }

    static func journalUpdated(_ date: String) {
        guard shouldEmit("journal_updated:\(date)") else { return }
        Telemetry.shared.track(.journalUpdated, surface: .journal, action: "updated", objectType: "journal", result: .success)
    }

    static func noteCreated() {
        Telemetry.shared.track(.noteCreated, surface: .notes, action: "created", objectType: "note", result: .success)
    }

    static func noteDeleted() {
        Telemetry.shared.track(.noteDeleted, surface: .notes, action: "deleted", objectType: "note", result: .success)
    }
}
