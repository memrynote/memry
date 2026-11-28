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
        let appVersion = TelemetryContext.appVersion(
            marketing: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        )
        let previousVersion = defaults.string(forKey: lastRunVersionKey)
        defaults.set(appVersion, forKey: lastRunVersionKey)

        let channel: String = switch SyncEnvironment.current {
        case let .resolved(environment): environment.telemetryBuildChannel
        case .misconfigured: "development"
        }
        let context = TelemetryContext(
            installId: installId,
            sessionId: UUID().uuidString.lowercased(),
            appVersion: appVersion,
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
