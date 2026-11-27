import Foundation
import MemryCore
import Testing

@testable import Memry

// #5600. Exporting a vault removed from the account: every file arrives
// byte-identical, and the vault's own folder is never changed, also when the
// export is cancelled or fails.

private struct Workspace {
    let root: URL
    let vault: URL
    let files: [String: Data]

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("removed-vault-export-\(UUID().uuidString)", isDirectory: true)
        vault = root.appendingPathComponent("vault/b", isDirectory: true)
        files = [
            "data.db": Data((0 ..< 4096).map { UInt8($0 % 251) }),
            "data.db-wal": Data("unsynced edit".utf8),
            "index.db": Data([0, 1, 2]),
            "images/a.png": Data(repeating: 7, count: 1000),
            "images/nested/b é.jpg": Data("bytes".utf8),
            "images/empty": Data()
        ]
        for (path, bytes) in files {
            let url = vault.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try bytes.write(to: url)
        }
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("out", isDirectory: true), withIntermediateDirectories: true
        )
    }

    var out: URL { root.appendingPathComponent("out", isDirectory: true) }

    /// Every file under `folder`, by relative path, with its bytes and its
    /// modification date.
    func tree(_ folder: URL) throws -> [String: Data] {
        var tree: [String: Data] = [:]
        let base = folder.standardizedFileURL.pathComponents.count
        let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey])
        while let url = walk?.nextObject() as? URL {
            guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { continue }
            let relative = url.standardizedFileURL.pathComponents.dropFirst(base).joined(separator: "/")
            tree[relative] = try Data(contentsOf: url)
        }
        return tree
    }

    func dates() throws -> [String: Date] {
        try files.keys.reduce(into: [:]) { dates, path in
            dates[path] = try FileManager.default
                .attributesOfItem(atPath: vault.appendingPathComponent(path).path)[.modificationDate] as? Date
        }
    }

    func remove() { try? FileManager.default.removeItem(at: root) }
}

private struct Stop: Error {}

@Suite("Removed vault export")
struct RemovedVaultExportTests {
    @Test("the export copies every file byte-identically and leaves the vault untouched")
    func copiesEveryFile() throws {
        let space = try Workspace()
        defer { space.remove() }
        let dates = try space.dates()

        var seen: [(Int, Int)] = []
        let folder = try VaultFolderCopy.copy(from: space.vault, into: space.out, named: "Personal") {
            seen.append(($0, $1))
        }

        #expect(folder.lastPathComponent == "Personal")
        #expect(try space.tree(folder) == space.files)
        #expect(try space.tree(space.vault) == space.files)
        #expect(try space.dates() == dates)
        #expect(seen.first! == (0, space.files.count))
        #expect(seen.last! == (space.files.count, space.files.count))
    }

    @Test("an existing folder of the same name is never written into")
    func neverOverwrites() throws {
        let space = try Workspace()
        defer { space.remove() }
        let existing = space.out.appendingPathComponent("Personal", isDirectory: true)
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: false)
        try Data("theirs".utf8).write(to: existing.appendingPathComponent("data.db"))

        let folder = try VaultFolderCopy.copy(from: space.vault, into: space.out, named: "Personal") { _, _ in }

        #expect(folder.lastPathComponent == "Personal 2")
        #expect(try space.tree(existing) == ["data.db": Data("theirs".utf8)])
        #expect(try space.tree(folder) == space.files)
    }

    @Test("a cancel partway removes only the partial copy and keeps the vault")
    func cancelKeepsTheSource() throws {
        let space = try Workspace()
        defer { space.remove() }
        let dates = try space.dates()

        #expect(throws: CancellationError.self) {
            try VaultFolderCopy.copy(from: space.vault, into: space.out, named: "Personal") { done, _ in
                if done == 2 { throw CancellationError() }
            }
        }

        #expect(try FileManager.default.contentsOfDirectory(atPath: space.out.path).isEmpty)
        #expect(try space.tree(space.vault) == space.files)
        #expect(try space.dates() == dates)
    }

    @Test("a failed copy keeps the vault and reports a visible error")
    @MainActor
    func failureKeepsTheSource() async throws {
        let space = try Workspace()
        defer { space.remove() }
        // A file where the destination folder should be: nothing can be made in it.
        let blocked = space.root.appendingPathComponent("not-a-folder")
        try Data().write(to: blocked)
        let vault = space.vault
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { vault }

        await export.start(into: blocked)?.value

        #expect(export.phase == .failed(RemovedVaultExport.exportFailed))
        #expect(try space.tree(space.vault) == space.files)
    }

    @Test("an export into a picked folder ends exported, named for the vault")
    @MainActor
    func exportsThroughTheModel() async throws {
        let space = try Workspace()
        defer { space.remove() }
        let vault = space.vault
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { vault }

        await export.start(into: space.out)?.value

        #expect(export.phase == .exported(folder: "Personal (memrynote export)"))
        let folder = space.out.appendingPathComponent("Personal (memrynote export)", isDirectory: true)
        #expect(try space.tree(folder) == space.files)
        #expect(try space.tree(space.vault) == space.files)
    }

    @Test("a source that cannot be found fails visibly and creates nothing")
    @MainActor
    func missingSource() async throws {
        let space = try Workspace()
        defer { space.remove() }
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { throw Stop() }

        await export.start(into: space.out)?.value

        #expect(export.phase == .failed(RemovedVaultExport.exportFailed))
        #expect(try FileManager.default.contentsOfDirectory(atPath: space.out.path).isEmpty)
    }

    @Test("a missing vault folder fails visibly and creates nothing")
    @MainActor
    func missingFolder() async throws {
        let space = try Workspace()
        defer { space.remove() }
        let gone = space.root.appendingPathComponent("vault/gone", isDirectory: true)
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { gone }

        await export.start(into: space.out)?.value

        #expect(export.phase == .failed(RemovedVaultExport.exportFailed))
        #expect(try FileManager.default.contentsOfDirectory(atPath: space.out.path).isEmpty)
    }

    @Test("a vault path that is a file, not a folder, fails visibly")
    @MainActor
    func notAFolder() async throws {
        let space = try Workspace()
        defer { space.remove() }
        let file = space.vault.appendingPathComponent("data.db")
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { file }

        await export.start(into: space.out)?.value

        #expect(export.phase == .failed(RemovedVaultExport.exportFailed))
        #expect(try FileManager.default.contentsOfDirectory(atPath: space.out.path).isEmpty)
    }

    @Test("an unreadable subfolder fails the export instead of skipping its files")
    @MainActor
    func unreadableSubfolder() async throws {
        let space = try Workspace()
        let nested = space.vault.appendingPathComponent("images/nested", isDirectory: true)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: nested.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nested.path)
            space.remove()
        }
        let vault = space.vault
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { vault }

        await export.start(into: space.out)?.value

        #expect(export.phase == .failed(RemovedVaultExport.exportFailed))
        #expect(try FileManager.default.contentsOfDirectory(atPath: space.out.path).isEmpty)
    }

    @Test("a file that fails partway removes the partial copy and keeps the vault")
    @MainActor
    func partialCopyRemoved() async throws {
        let space = try Workspace()
        let locked = space.vault.appendingPathComponent("images/a.png")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: locked.path)
            space.remove()
        }
        let vault = space.vault
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: "Personal")) { vault }

        await export.start(into: space.out)?.value

        #expect(export.phase == .failed(RemovedVaultExport.exportFailed))
        #expect(try FileManager.default.contentsOfDirectory(atPath: space.out.path).isEmpty)
    }

    @Test("each write-ahead log is copied before its database")
    func walBeforeDatabase() throws {
        let space = try Workspace()
        defer { space.remove() }
        try Data("vectors".utf8).write(to: space.vault.appendingPathComponent("vectors.db"))
        try Data("vectors wal".utf8).write(to: space.vault.appendingPathComponent("vectors.db-wal"))

        let order = try VaultFolderCopy.files(under: space.vault)

        for wal in order where wal.hasSuffix("-wal") {
            let database = String(wal.dropLast(4))
            #expect(order.firstIndex(of: wal)! < order.firstIndex(of: database)!)
        }
        #expect(Set(order) == Set(space.files.keys).union(["vectors.db", "vectors.db-wal"]))
    }

    @Test("a long vault name still exports, under a shortened folder name")
    @MainActor
    func longName() async throws {
        let space = try Workspace()
        defer { space.remove() }
        let vault = space.vault
        let long = String(repeating: "é", count: 300)
        let export = RemovedVaultExport(summary: VaultSummary(id: "b", name: long)) { vault }

        await export.start(into: space.out)?.value

        guard case let .exported(folder) = export.phase else {
            Issue.record("expected exported, got \(export.phase)")
            return
        }
        #expect(folder.hasSuffix(" (memrynote export)"))
        #expect(folder.decomposedStringWithCanonicalMapping.utf8.count <= 255)
        #expect(try space.tree(space.out.appendingPathComponent(folder, isDirectory: true)) == space.files)
    }
}
