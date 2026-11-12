import Foundation

/// The telemetry queue on disk, so events recorded shortly before the app is
/// killed still leave on the next launch. One JSON file, written atomically.
/// A file that does not decode (an older or newer build's shape) is dropped:
/// losing queued telemetry is preferable to sending a batch the server
/// rejects whole.
struct TelemetryQueueStore: Sendable {
    let url: URL?

    static func applicationSupport() -> TelemetryQueueStore {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return TelemetryQueueStore(url: directory?.appendingPathComponent("telemetry-queue.json"))
    }

    func load() -> [TelemetryEvent] {
        guard let url, let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONDecoder().decode([TelemetryEvent].self, from: data)
        } catch {
            Log.storage.notice("telemetry queue unreadable, dropped")
            return []
        }
    }

    func save(_ events: [TelemetryEvent]) {
        guard let url else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try JSONEncoder().encode(events).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            Log.storage.notice("telemetry queue not saved")
        }
    }
}
