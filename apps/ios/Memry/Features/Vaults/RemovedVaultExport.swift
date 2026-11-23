import Foundation
import MemryCore
import Observation

// #5600. A vault removed from the account while this device was offline keeps
// its folder here, with whatever was written to it and never synced. Nothing
// opens it any more, so the only way to its content is a copy the user takes
// out to Files. The copy reads the folder and never writes, moves or deletes
// anything in it: a cancel or a failure removes only the folder the export made.

/// Copies one folder's tree, file by file, into a new folder.
enum VaultFolderCopy {
    /// Copies every file under `source` into a new folder called `name` inside
    /// `parent`, and returns it. An existing folder of that name is never
    /// written into: the copy takes the next free "name 2", "name 3".
    ///
    /// Blocking, so callers run it off the main actor. `progress` gets
    /// (files copied, files in total) and may throw to stop; a stopped or
    /// failed copy removes the folder it made and rethrows.
    static func copy(
        from source: URL,
        into parent: URL,
        named name: String,
        progress: (Int, Int) throws -> Void
    ) throws -> URL {
        let manager = FileManager.default
        let files = try files(under: source)
        let destination = try freshFolder(in: parent, named: name)
        do {
            try progress(0, files.count)
            for (index, relative) in files.enumerated() {
                let target = destination.appendingPathComponent(relative)
                try manager.createDirectory(
                    at: target.deletingLastPathComponent(), withIntermediateDirectories: true
                )
                try manager.copyItem(at: source.appendingPathComponent(relative), to: target)
                try progress(index + 1, files.count)
            }
            return destination
        } catch {
            do {
                try manager.removeItem(at: destination)
            } catch {
                Log.storage.error("a stopped vault export left its partial copy behind")
            }
            throw error
        }
    }

    /// Paths relative to `source`, read before anything is copied so the
    /// total is known. Each `-wal` comes before its database, so a copy that
    /// stops between the two never holds a database without its log. A
    /// missing folder, or a subfolder the walk cannot read, throws: a copy
    /// with files silently left out must never read as exported.
    static func files(under source: URL) throws -> [String] {
        guard try source.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        let keys: [URLResourceKey] = [.isRegularFileKey]
        var walkError: (any Error)?
        guard let walk = FileManager.default.enumerator(
            at: source, includingPropertiesForKeys: keys, options: [], errorHandler: { _, error in
                walkError = error
                return false
            }
        ) else { throw CocoaError(.fileReadNoSuchFile) }
        let base = source.standardizedFileURL.pathComponents.count
        var files: [String] = []
        for case let url as URL in walk where try url.resourceValues(forKeys: Set(keys)).isRegularFile == true {
            files.append(url.standardizedFileURL.pathComponents.dropFirst(base).joined(separator: "/"))
        }
        if let walkError { throw walkError }
        return files.sorted { copyOrder($0) < copyOrder($1) }
    }

    private static func copyOrder(_ path: String) -> (String, Int) {
        path.hasSuffix("-wal") ? (String(path.dropLast(4)), 0) : (path, 1)
    }

    private static func freshFolder(in parent: URL, named name: String) throws -> URL {
        let safe = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        for attempt in 1 ... 1000 {
            let candidate = parent.appendingPathComponent(attempt == 1 ? safe : "\(safe) \(attempt)", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: false)
                return candidate
            } catch CocoaError.fileWriteFileExists {
                continue
            }
        }
        throw CocoaError(.fileWriteFileExists)
    }
}

/// The export of one removed vault, from the notice that names it.
@MainActor
@Observable
final class RemovedVaultExport {
    enum Phase: Equatable {
        case idle
        case copying(done: Int, total: Int)
        case exported(folder: String)
        case failed(UserFacingError)
    }

    let summary: VaultSummary
    private(set) var phase: Phase = .idle
    private let source: @Sendable () throws -> URL
    private var task: Task<Void, Never>?

    /// - Parameter source: the vault's folder on this device.
    init(summary: VaultSummary, source: @escaping @Sendable () throws -> URL) {
        self.summary = summary
        self.source = source
    }

    var isCopying: Bool {
        if case .copying = phase { return true }
        return false
    }

    /// Copies the vault into `destination`, a folder the user picked. The
    /// walk and the copy run off the main actor; the screen sees progress.
    /// Returns the copy's task, which ends after `phase` settles, or nil when
    /// a copy is already running.
    @discardableResult
    func start(into destination: URL) -> Task<Void, Never>? {
        guard !isCopying else { return nil }
        phase = .copying(done: 0, total: 0)
        let source = source
        // A file name holds 255 UTF-8 bytes, counted here decomposed, the
        // longest form a file system may store. 200 for the label leaves room
        // for the suffix and a " 1000" from a name clash.
        var label = VaultLabel(summary).text
        while label.decomposedStringWithCanonicalMapping.utf8.count > 200 { label.removeLast() }
        let name = "\(label) (memrynote export)"
        task = Task.detached { [weak self] in
            let result = destination.withSecurityScope {
                Result {
                    try VaultFolderCopy.copy(from: try source(), into: destination, named: name) { done, total in
                        try Task.checkCancellation()
                        // One hop per hundred files: a 16k-file vault would
                        // otherwise queue 16k main-actor updates.
                        guard done == total || done % 100 == 0 else { return }
                        Task { @MainActor in self?.progressed(done, total) }
                    }
                }
            }
            await self?.finished(result)
        }
        return task
    }

    /// The folder picker itself failed, before any copy started.
    func pickerFailed() {
        Log.storage.error("the export folder picker failed")
        phase = .failed(Self.exportFailed)
    }

    func cancel() {
        task?.cancel()
    }

    static let exportFailed = UserFacingError(
        code: "shell.vaultExportFailed",
        title: "The copy could not be exported.",
        guidance: "Your vault is still on this \(ThisDevice.noun). "
            + "Free up space or choose another folder, then try again.",
        recourse: .retry,
        isUserVisible: true
    )

    private func progressed(_ done: Int, _ total: Int) {
        if isCopying { phase = .copying(done: done, total: total) }
    }

    private func finished(_ result: Result<URL, any Error>) {
        task = nil
        switch result {
        case let .success(folder):
            Log.storage.notice("a removed vault was exported")
            phase = .exported(folder: folder.lastPathComponent)
        case let .failure(error) where error is CancellationError:
            Log.storage.info("a removed vault export was cancelled")
            phase = .idle
        case let .failure(error):
            // The Cocoa code says which step failed (no space, no permission)
            // without carrying a path.
            Log.storage.error("a removed vault could not be exported", .status((error as NSError).code))
            phase = .failed(Self.exportFailed)
        }
    }
}
