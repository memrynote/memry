import Foundation
import os

// The app's own log lines on disk, so in-app feedback can attach the history
// of earlier launches too: a first sync that restarts on every relaunch is
// only visible across relaunches, and OSLog cannot be read back from a
// previous process.
//
// Every line comes from `Log`, whose messages are compile-time literals plus a
// closed set of numbers and error codes (`Log.swift`), so nothing written here
// can carry note text, a title, a key, a token or the recovery phrase. The one
// line this file writes itself, the launch marker, holds only the app version,
// the OS version and the device model.
//
// Bounded: two files of at most `fileLimit` bytes each. When the current file
// passes the limit it becomes the previous one, replacing it. Writes happen on
// one serial queue, so a log call never waits on the disk.

final class DiagnosticLog: @unchecked Sendable {
    static let shared = DiagnosticLog(directory: FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
        .appendingPathComponent("Diagnostics", isDirectory: true))

    static let fileLimit = 192 * 1024

    private let current: URL?
    private let previous: URL?
    private let limit: Int
    private let queue = DispatchQueue(label: "com.memry.ios.diagnostic-log", qos: .utility)
    /// Confined to `queue`.
    private var handle: FileHandle?

    init(directory: URL?, limit: Int = DiagnosticLog.fileLimit) {
        current = directory?.appendingPathComponent("diagnostics.log")
        previous = directory?.appendingPathComponent("diagnostics.1.log")
        self.limit = limit
        if var directory {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? directory.setResourceValues(values)
        }
    }

    /// One `Log` line, stamped in UTC.
    func append(_ level: OSLogType, _ subsystem: LogSubsystem, _ line: String, at date: Date = .now) {
        write("\(Self.stamp(date)) \(Self.name(level)) \(subsystem.rawValue) \(line)\n")
    }

    /// The first line of each launch, so the log shows where one process ended
    /// and the next began, and which build wrote what follows.
    func markLaunch(_ facts: DeviceFacts, at date: Date = .now) {
        write("\(Self.stamp(date)) --- launch \(facts.appVersion) (\(facts.appBuild)) \(facts.platform) \(facts.osVersion) \(facts.deviceModel) ---\n")
    }

    /// Everything on disk, oldest first, after every write queued before it.
    func contents() -> String {
        queue.sync {
            try? handle?.synchronize()
            return [previous, current]
                .compactMap { $0.flatMap { try? String(contentsOf: $0, encoding: .utf8) } }
                .joined()
        }
    }

    /// Blocks until queued writes are on disk. For tests.
    func flush() {
        queue.sync { try? handle?.synchronize() }
    }

    private func write(_ text: String) {
        queue.async { [self] in
            guard let current else { return }
            do {
                if handle == nil {
                    if !FileManager.default.fileExists(atPath: current.path) {
                        FileManager.default.createFile(atPath: current.path, contents: nil)
                    }
                    handle = try FileHandle(forWritingTo: current)
                    try handle?.seekToEnd()
                }
                try handle?.write(contentsOf: Data(text.utf8))
                if let size = try handle?.offset(), size > UInt64(limit) { try rotate() }
            } catch {
                // Logging this failure through `Log` would loop back here.
                try? handle?.close()
                handle = nil
            }
        }
    }

    /// The current file becomes the previous one. Runs on `queue`.
    private func rotate() throws {
        guard let current, let previous else { return }
        try handle?.close()
        handle = nil
        try? FileManager.default.removeItem(at: previous)
        try FileManager.default.moveItem(at: current, to: previous)
    }

    private static func stamp(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    private static func name(_ level: OSLogType) -> String {
        switch level {
        case .debug: "debug"
        case .info: "info"
        case .error: "error"
        case .fault: "fault"
        default: "notice"
        }
    }
}

/// What a feedback email and a launch marker say about this install. None of
/// it identifies the person: the model is the hardware identifier
/// (`iPhone17,3`), not the name someone gave their phone.
struct DeviceFacts: Sendable, Equatable {
    let appVersion: String
    let appBuild: String
    let platform: String
    let osVersion: String
    let deviceModel: String

    static func current(bundle: Bundle = .main, process: ProcessInfo = .processInfo) -> DeviceFacts {
        let os = process.operatingSystemVersion
        return DeviceFacts(
            appVersion: bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
            appBuild: bundle.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
            platform: "iOS",
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            deviceModel: process.environment["SIMULATOR_MODEL_IDENTIFIER"].map { "\($0) (Simulator)" } ?? hardwareModel()
        )
    }

    private static func hardwareModel() -> String {
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { buffer in
            String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}
