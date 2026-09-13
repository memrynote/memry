import Foundation
import os

// B0 spike scaffolding (research.md §F). No product code depends on anything in
// this directory; it exists to produce the four spike notes in
// `research.md` §Addenda and is deletable once G3a is recorded.

/// One observation of the thread a foreign-trait callback ran on.
///
/// `Thread.current` is the whole point of S1: research §E carries "UniFFI
/// callback threading guarantees" as explicitly uncertain, with the instruction
/// to treat callbacks as *any thread, re-entrant* until a spike says otherwise.
struct SpikeCallbackObservation: Sendable, Equatable {
    let seam: String
    let method: String
    let threadDescription: String
    let isMainThread: Bool
    let qualityOfService: Int
    /// What a core call made from *inside* this callback returned, when the
    /// probe was installed. `nil` when no re-entrant call was attempted.
    var reentrantResult: String?

    init(seam: String, method: String) {
        self.seam = seam
        self.method = method
        self.threadDescription = Thread.current.description
        self.isMainThread = Thread.isMainThread
        self.qualityOfService = Thread.current.qualityOfService.rawValue
        self.reentrantResult = nil
    }
}

/// Append-only, lock-guarded. Callbacks arrive on threads the shell does not
/// choose, which is the fact under test, so the log cannot assume one.
final class SpikeObservationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [SpikeCallbackObservation] = []
    private let logger = Logger(subsystem: "com.memry.ios", category: "spike")

    func record(_ observation: SpikeCallbackObservation) {
        lock.lock()
        entries.append(observation)
        lock.unlock()
        logger.info(
            """
            callback seam=\(observation.seam, privacy: .public) \
            method=\(observation.method, privacy: .public) \
            thread=\(observation.threadDescription, privacy: .public) \
            main=\(observation.isMainThread, privacy: .public) \
            qos=\(observation.qualityOfService, privacy: .public) \
            reentrant=\(observation.reentrantResult ?? "-", privacy: .public)
            """
        )
    }

    var all: [SpikeCallbackObservation] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}
