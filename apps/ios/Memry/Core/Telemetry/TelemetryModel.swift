import Foundation

// The wire shape of `POST /telemetry/batch`, mirrored from
// `TelemetryBatchSchema` in `packages/contracts/src/telemetry-api.ts`. The
// contract owns every name and limit here; a case missing from it makes the
// server reject the whole batch with a 400, so nothing is added on this side
// first.
//
// Privacy is held by the types, the way `Log.swift` holds it: an action, an
// object type and a source are `StaticString`s, an error code is an
// `ErrorCode` literal, and a dimension key comes from the contract's closed
// allowlist. Note text, titles, ids and queries have no field to go in.

enum TelemetryEventName: String, Codable, Sendable {
    case appStarted = "app_started"
    case appBackgrounded = "app_backgrounded"
    case appActiveHeartbeat = "app_active_heartbeat"
    case appUpdateInstalled = "app_update_installed"
    case appErrorSeen = "app_error_seen"
    case appCrashed = "app_crashed"
    case onboardingStarted = "onboarding_started"
    case onboardingCompleted = "onboarding_completed"
    case vaultCreated = "vault_created"
    case vaultOpened = "vault_opened"
    case pageViewed = "page_viewed"
    case noteCreated = "note_created"
    case noteOpened = "note_opened"
    case noteUpdated = "note_updated"
    case noteDeleted = "note_deleted"
    case journalOpened = "journal_opened"
    case journalUpdated = "journal_updated"
    case taskCreated = "task_created"
    case taskCompleted = "task_completed"
    case taskReopened = "task_reopened"
    case taskUpdated = "task_updated"
    case taskDeleted = "task_deleted"
    case projectCreated = "project_created"
    case projectOpened = "project_opened"
    case projectUpdated = "project_updated"
    case projectArchived = "project_archived"
    case projectDeleted = "project_deleted"
    case inboxCaptured = "inbox_captured"
    case inboxFiled = "inbox_filed"
    case inboxArchived = "inbox_archived"
    case inboxSnoozed = "inbox_snoozed"
    case searchOpened = "search_opened"
    case searchPerformed = "search_performed"
    case searchResultOpened = "search_result_opened"
    case calendarEventCreated = "calendar_event_created"
    case calendarEventUpdated = "calendar_event_updated"
    case calendarEventDeleted = "calendar_event_deleted"
    case calendarGoogleConnected = "calendar_google_connected"
    case calendarGoogleDisconnected = "calendar_google_disconnected"
    case readwiseConnected = "readwise_connected"
    case readwiseDisconnected = "readwise_disconnected"
    case settingChanged = "setting_changed"
    case syncEnabled = "sync_enabled"
    case syncRunCompleted = "sync_run_completed"
    case syncError = "sync_error"
    case syncBootstrap = "sync_bootstrap"
    case voiceRecordingCompleted = "voice_recording_completed"
    case transcriptionCompleted = "transcription_completed"
    case tagCreated = "tag_created"
    case tagRenamed = "tag_renamed"
    case tagDeleted = "tag_deleted"
    case tagMerged = "tag_merged"
    case reminderCreated = "reminder_created"
    case reminderDeleted = "reminder_deleted"
    case deepLinkOpened = "deep_link_opened"
    case canvasCreated = "canvas_created"
    case canvasOpened = "canvas_opened"
    case canvasDeleted = "canvas_deleted"
}

enum TelemetrySurface: String, Codable, Sendable {
    case app, home, onboarding, vault, notes, journal, tasks, inbox, calendar, search
    case settings, sync, voice, updater, canvas, projects, tags
}

enum TelemetryResult: String, Codable, Sendable {
    case success, failed, canceled, skipped
}

/// `TELEMETRY_DIMENSION_KEYS`. A dimension's value must be enumerable ahead of
/// time (an enum case, a version, a bucket label), never user content.
enum TelemetryDimensionKey: String, Codable, Sendable {
    case captureType = "capture_type"
    case changedFields = "changed_fields"
    case decision
    case filedAction = "filed_action"
    case format
    case fromVersion = "from_version"
    case itemType
    case noteBucket = "note_bucket"
    case priorAppVersion = "prior_app_version"
    case resultBucket = "result_bucket"
    case setting
    case sizeBucket = "size_bucket"
    case skipReason = "skip_reason"
    case target
    case transport
    case value
}

struct TelemetryMetrics: Codable, Sendable, Equatable {
    var durationMs: Double?
    var itemCount: Double?
    var byteCount: Double?
    var queueCount: Double?
    var resultCount: Double?
    var retryCount: Double?
    var activeSeconds: Double?
    var value: Double?
}

/// `TelemetryFailureDetailSchema`: bounded facts about a failed request.
struct TelemetryFailure: Codable, Sendable, Equatable {
    var httpStatus: Int?
    var serverCode: String?
    var retryable: Bool?
}

/// `TelemetryErrorDetailSchema`. Only ever a `StaticString` message here.
struct TelemetryErrorDetail: Codable, Sendable, Equatable {
    var message: String
}

struct TelemetryEvent: Codable, Sendable, Equatable {
    let id: String
    let name: TelemetryEventName
    let occurredAt: String
    let surface: TelemetrySurface
    let action: String
    var objectType: String?
    var source: String?
    var result: TelemetryResult?
    var errorCode: String?
    var dimensions: [String: String]?
    var metrics: TelemetryMetrics?
    var error: TelemetryErrorDetail?
    var failure: TelemetryFailure?
}

enum TelemetryAuthState: String, Codable, Sendable {
    case anonymous
    case signedIn = "signed_in"
    case signedOut = "signed_out"
}

enum TelemetrySyncState: String, Codable, Sendable {
    case disabled, enabled, unknown
}

/// What does not change within one launch.
struct TelemetryContext: Sendable, Equatable {
    let installId: String
    let sessionId: String
    let appVersion: String
    /// `development | staging | production`, from the sync environment.
    let buildChannel: String
    let locale: String
    let timezoneOffsetMinutes: Int
}

struct TelemetryBatch: Encodable {
    let schemaVersion = 1
    let installId: String
    let sessionId: String
    let appVersion: String
    let buildChannel: String
    let platform = "ios"
    let arch = "arm64"
    let locale: String
    let timezoneOffsetMinutes: Int
    let authState: TelemetryAuthState
    let syncState: TelemetrySyncState
    let clientQueueDepth: Int
    let events: [TelemetryEvent]

    init(
        context: TelemetryContext,
        authState: TelemetryAuthState,
        syncState: TelemetrySyncState,
        queueDepth: Int,
        events: [TelemetryEvent]
    ) {
        installId = context.installId
        sessionId = context.sessionId
        appVersion = context.appVersion
        buildChannel = context.buildChannel
        locale = context.locale
        timezoneOffsetMinutes = context.timezoneOffsetMinutes
        self.authState = authState
        self.syncState = syncState
        clientQueueDepth = min(queueDepth, 1000)
        self.events = events
    }
}

extension SyncEnvironment {
    var telemetryBuildChannel: String {
        switch self {
        case .production: "production"
        case .staging: "staging"
        case .local: "development"
        }
    }
}
