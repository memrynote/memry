import Foundation
import MemryCore

// Product telemetry for the iOS app, through the same `/telemetry/batch` route
// and PostHog project desktop uses (`apps/desktop/src/main/telemetry/`).
//
// One actor owns the queue. Call sites use the nonisolated `track` and never
// wait. Events queue on disk and leave in batches of up to 50: every 30 seconds
// while the app is active, and when it leaves the foreground. The core sends
// each batch (`AuthSession.sendTelemetry`) so the access token never reaches
// Swift; the server attributes the batch to an account hash when one is signed
// in and to the install otherwise.
//
// Turning "Share usage metrics" off drops the queue and records nothing more.
// Telemetry never breaks a feature: no call here throws, and a failure is a log
// line.

/// Sends one serialised batch. `AuthSession` in production.
protocol TelemetrySending: Sendable {
    func sendTelemetry(batchJson: Data) async -> TelemetryDelivery
}

extension AuthSession: TelemetrySending {}

actor Telemetry {
    static let shared = Telemetry(store: TelemetryQueueStore.applicationSupport())

    static let queueLimit = 500
    static let batchLimit = 50
    static let flushIntervalSeconds: UInt64 = 30
    static let heartbeatIntervalSeconds: Double = 300

    private let store: TelemetryQueueStore
    private var queue: [TelemetryEvent]
    private var enabled = false
    /// Whether this build reports at all; the user's switch works inside it.
    private var allowed = false
    private var context: TelemetryContext?
    private var sender: (any TelemetrySending)?
    private var authState: TelemetryAuthState = .anonymous
    private var syncState: TelemetrySyncState = .unknown
    private var flushing = false
    private var unsaved = 0
    private var flushLoop: Task<Void, Never>?
    private var activeSince: Date?

    init(store: TelemetryQueueStore) {
        self.store = store
        queue = store.load()
    }

    // MARK: Configuration

    /// Called once at launch, before any other event is worth recording.
    /// Emits `app_started`, and `app_update_installed` when the version moved.
    func start(context: TelemetryContext, allowed: Bool, enabled: Bool, previousVersion: String?) {
        self.context = context
        self.allowed = allowed
        setEnabled(enabled)
        record(TelemetryEvent.make(.appStarted, surface: .app, action: "started", result: .success))
        if let previousVersion, previousVersion != context.appVersion {
            var event = TelemetryEvent.make(.appUpdateInstalled, surface: .updater, action: "installed", result: .success)
            event.dimensions = TelemetryEvent.dimension(.fromVersion, previousVersion)
            record(event)
        }
    }

    func attach(sender: any TelemetrySending) {
        self.sender = sender
    }

    func setEnabled(_ on: Bool) {
        enabled = allowed && on
        guard !enabled else { return }
        queue.removeAll()
        unsaved = 0
        store.save(queue)
    }

    func setAuthState(_ state: TelemetryAuthState) { authState = state }
    func setSyncState(_ state: TelemetrySyncState) { syncState = state }

    // MARK: Recording

    nonisolated func track(
        _ name: TelemetryEventName,
        surface: TelemetrySurface,
        action: StaticString,
        objectType: StaticString? = nil,
        source: StaticString? = nil,
        result: TelemetryResult? = nil,
        errorCode: ErrorCode? = nil,
        dimension: (TelemetryDimensionKey, String)? = nil,
        metrics: TelemetryMetrics? = nil,
        failure: TelemetryFailure? = nil
    ) {
        var event = TelemetryEvent.make(name, surface: surface, action: action.description, result: result)
        event.objectType = objectType?.description
        event.source = source?.description
        event.errorCode = errorCode?.description
        event.dimensions = dimension.flatMap { TelemetryEvent.dimension($0.0, $0.1) }
        event.metrics = metrics
        event.failure = failure
        Task { await self.record(event) }
    }

    /// An error- or fault-level `Log` line, as `app_error_seen`. The message
    /// is the line's `StaticString`, so it carries no runtime text.
    nonisolated func logged(_ message: StaticString, code: ErrorCode?, subsystem: LogSubsystem) {
        var event = TelemetryEvent.make(.appErrorSeen, surface: subsystem.telemetrySurface, action: "error", result: .failed)
        event.source = subsystem.rawValue
        event.errorCode = code?.description ?? TelemetryEvent.errorCode(for: message)
        event.error = TelemetryErrorDetail(message: message.description)
        Task { await self.record(event) }
    }

    func record(_ event: TelemetryEvent) {
        guard enabled else { return }
        queue.append(event)
        if queue.count > Self.queueLimit { queue.removeFirst(queue.count - Self.queueLimit) }
        unsaved += 1
        if unsaved >= 10 { persist() }
    }

    // MARK: Lifecycle

    /// The scene became active: start the flush loop and the active clock.
    func becameActive() {
        activeSince = Date()
        guard flushLoop == nil else { return }
        flushLoop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.flushIntervalSeconds * 1_000_000_000)
                await self?.tick()
            }
        }
    }

    /// The scene left the foreground: report the active time, then flush.
    func becameInactive() async {
        flushLoop?.cancel()
        flushLoop = nil
        reportActiveTime()
        activeSince = nil
        record(TelemetryEvent.make(.appBackgrounded, surface: .app, action: "backgrounded"))
        persist()
        await flush()
    }

    private func tick() async {
        if let activeSince, Date().timeIntervalSince(activeSince) >= Self.heartbeatIntervalSeconds {
            reportActiveTime()
        }
        await flush()
    }

    private func reportActiveTime() {
        guard let since = activeSince else { return }
        let seconds = Date().timeIntervalSince(since).rounded()
        activeSince = Date()
        guard seconds >= 1 else { return }
        var event = TelemetryEvent.make(.appActiveHeartbeat, surface: .app, action: "heartbeat")
        event.metrics = TelemetryMetrics(activeSeconds: seconds)
        record(event)
    }

    // MARK: Delivery

    func flush() async {
        guard enabled, !flushing, let context, let sender else { return }
        flushing = true
        defer { flushing = false }
        while !queue.isEmpty {
            let events = Array(queue.prefix(Self.batchLimit))
            let batch = TelemetryBatch(
                context: context,
                authState: authState,
                syncState: syncState,
                queueDepth: queue.count,
                events: events
            )
            guard let body = try? JSONEncoder().encode(batch) else {
                Log.app.error("telemetry batch did not encode")
                queue.removeFirst(events.count)
                continue
            }
            let delivery = await sender.sendTelemetry(batchJson: body)
            if delivery == .retryLater { break }
            if delivery == .rejected {
                Log.app.notice("telemetry batch rejected", .count(events.count))
            }
            // The queue may have been cleared by an opt-out while the send
            // was in flight, so drop only what is still there.
            let sent = Set(events.map(\.id))
            queue.removeAll { sent.contains($0.id) }
        }
        persist()
    }

    private func persist() {
        unsaved = 0
        store.save(queue)
    }

    // MARK: Testing

    var pending: [TelemetryEvent] { queue }
}

extension TelemetryEvent {
    static func make(
        _ name: TelemetryEventName,
        surface: TelemetrySurface,
        action: String,
        result: TelemetryResult? = nil
    ) -> TelemetryEvent {
        TelemetryEvent(
            id: UUID().uuidString.lowercased(),
            name: name,
            // `2026-05-01T12:00:00.000Z`, which `z.iso.datetime()` accepts.
            occurredAt: Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(Date()),
            surface: surface,
            action: action,
            result: result
        )
    }

    /// One allowlisted dimension, or `nil` when the value would fail the
    /// server's safe-value shape (an `@`, a `://`, a slash, over 64 chars).
    static func dimension(_ key: TelemetryDimensionKey, _ value: String) -> [String: String]? {
        guard !value.isEmpty, value.count <= 64,
              !value.contains("@"), !value.contains("://"),
              !value.contains("/"), !value.contains("\\") else { return nil }
        return [key.rawValue: value]
    }

    /// A `Log` message as an error code: the safe-token form desktop's
    /// `toSafeToken` produces, so the same line groups as one issue.
    static func errorCode(for message: StaticString) -> String {
        let token = message.description.map { $0.isLetter || $0.isNumber ? $0 : "_" }
        return String(String(token).prefix(64))
    }
}

extension LogSubsystem {
    var telemetrySurface: TelemetrySurface {
        switch self {
        case .sync, .transport: .sync
        case .capture: .inbox
        case .app, .core, .auth, .secureStore, .storage, .interface: .app
        }
    }
}
