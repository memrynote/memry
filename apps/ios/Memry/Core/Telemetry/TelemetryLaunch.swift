import Foundation
import MetricKit
import UIKit

/// Starts telemetry at launch and feeds it the process's lifecycle.
@MainActor
enum TelemetryLaunch {
    private static let installIdKey = "telemetry.installId"
    private static let lastRunVersionKey = "telemetry.lastRunVersion"
    private static let crashes = CrashReporter()

    /// From `application(_:didFinishLaunchingWithOptions:)`.
    static func start(defaults: UserDefaults = .standard, bundle: Bundle = .main) {
        let installId: String
        if let stored = defaults.string(forKey: installIdKey) {
            installId = stored
        } else {
            installId = UUID().uuidString.lowercased()
            defaults.set(installId, forKey: installIdKey)
        }
        let appVersion = (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        let previousVersion = defaults.string(forKey: lastRunVersionKey)
        defaults.set(appVersion, forKey: lastRunVersionKey)

        let channel: String = switch SyncEnvironment.current {
        case let .resolved(environment): environment.telemetryBuildChannel
        case .misconfigured: "development"
        }
        let context = TelemetryContext(
            installId: installId,
            sessionId: UUID().uuidString.lowercased(),
            appVersion: String(appVersion.prefix(32)),
            buildChannel: channel,
            locale: String(Locale.current.identifier(.bcp47).prefix(16)),
            timezoneOffsetMinutes: TimeZone.current.secondsFromGMT() / 60
        )
        // As on desktop, only production builds report by default. A Debug
        // build opts in with `--telemetry`; a test host never reports, since
        // the unit plan runs inside the app and its writes are not usage.
        let process = ProcessInfo.processInfo
        let underTest = process.environment["XCTestConfigurationFilePath"] != nil
        let reports = channel == "production" || process.arguments.contains("--telemetry")
        let allowed = !underTest && reports
        let enabled = LocalSettings.shared.usageMetrics
        Task { await Telemetry.shared.start(context: context, allowed: allowed, enabled: enabled, previousVersion: previousVersion) }
        MXMetricManager.shared.add(crashes)
    }

    /// From the root view's scene phase.
    static func scenePhaseChanged(active: Bool) {
        if active {
            Task { await Telemetry.shared.becameActive() }
            return
        }
        // Leaving the foreground leaves a few seconds to send what is queued.
        let application = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        task = application.beginBackgroundTask(withName: "telemetry-flush") {
            application.endBackgroundTask(task)
        }
        Task {
            await Telemetry.shared.becameInactive()
            application.endBackgroundTask(task)
        }
    }
}

/// MetricKit hands the previous session's crash and hang diagnostics to the
/// next launch. Each crash becomes `app_crashed`, coded by its Mach exception
/// and signal (`EXC_BAD_ACCESS:SIGSEGV`), so PostHog counts and groups them.
/// The symbolicated stack stays in TestFlight and Xcode Organizer; nothing
/// from the call tree is sent.
final class CrashReporter: NSObject, MXMetricManagerSubscriber {
    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        var events: [TelemetryEvent] = []
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                var event = TelemetryEvent.make(.appCrashed, surface: .app, action: "unclean_shutdown", result: .failed)
                event.source = "metrickit"
                event.errorCode = Self.code(exception: crash.exceptionType?.intValue, signal: crash.signal?.intValue)
                events.append(event)
            }
            for hang in payload.hangDiagnostics ?? [] {
                var event = TelemetryEvent.make(.appErrorSeen, surface: .app, action: "hang", result: .failed)
                event.source = "metrickit"
                event.errorCode = "APP_HANG"
                event.metrics = TelemetryMetrics(durationMs: hang.hangDuration.converted(to: .milliseconds).value)
                events.append(event)
            }
        }
        guard !events.isEmpty else { return }
        Task {
            for event in events { await Telemetry.shared.record(event) }
        }
    }

    static func code(exception: Int?, signal: Int?) -> String {
        let exceptionName = switch exception {
        case 1: "EXC_BAD_ACCESS"
        case 2: "EXC_BAD_INSTRUCTION"
        case 3: "EXC_ARITHMETIC"
        case 5: "EXC_SOFTWARE"
        case 6: "EXC_BREAKPOINT"
        case 10: "EXC_CRASH"
        case 11: "EXC_RESOURCE"
        case 12: "EXC_GUARD"
        case let .some(other): "EXC_\(other)"
        case nil: "EXC_UNKNOWN"
        }
        let signalName = switch signal {
        case 4: "SIGILL"
        case 5: "SIGTRAP"
        case 6: "SIGABRT"
        case 8: "SIGFPE"
        case 9: "SIGKILL"
        case 10: "SIGBUS"
        case 11: "SIGSEGV"
        case let .some(other): "SIG\(other)"
        case nil: "SIGNONE"
        }
        return "\(exceptionName):\(signalName)"
    }
}
