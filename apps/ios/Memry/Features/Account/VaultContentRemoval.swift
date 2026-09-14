import Foundation
import MemryCore

// T159, the filesystem half of FR-025 and FR-026. **This is the only code in
// the shell that deletes anything a user cannot get back.**
//
// data-model §B: sign-out "deletes all five entries, deletes both database
// files and the `images/` directory". The five entries are the core's — its
// `sign_out` and `mark_revoked` both call `SecureStore::clear`, which is
// `Keychain.clear()` — and the files are the shell's, "because that type does
// not own them" (`AuthSession.signOut`'s own doc). This is that half.
//
// **It removes every vault, not one.** `MASTER_KEY` is one entry per account
// (data-model §B) and chapter 01 §1.7 derives every vault key from it with no
// per-vault input, so signing out of the account leaves no vault on this phone
// openable. Removing one directory and keeping the others would leave content
// behind that the user was told had gone.
//
// **The sidecars are why this deletes directories rather than three named
// files.** A `-wal` holds recent note content in plaintext (`FileProtection`'s
// header), it exists only while a connection is open, and after a clean close
// it is gone — so what is on disk at this moment depends on whether a vault was
// open when the user tapped. Removing the directory tree covers every file the
// layout can hold, including one a future migration adds.
//
// **Best effort, then honest**, which is `Keychain.clear()`'s shape and for the
// same reason: one unremovable directory must not strand the rest, and the call
// must not report success while content survives. Every child is attempted,
// each removal is **read back**, and the first failure is thrown afterwards.
//
// **No path is ever logged or put in an error.** A vault directory's name is
// the vault id and its parent is the container id (`FileProtection`'s
// "No path ever"). The count is safe; the names are not.

/// Removing every vault's local content from this device.
///
/// A protocol so the whole destruction can be driven from a test without a
/// filesystem, and — the half that matters — so a test can make a removal
/// **fail** on demand. A real filesystem does not refuse to delete a file when
/// asked to, and "the keychain went and the files did not" is the state this
/// task exists to make survivable rather than accidental.
protocol VaultContentRemoval: Sendable {
    /// Removes every vault directory and the directory that holds them.
    ///
    /// - Returns: how many entries were removed. **Zero is not a failure**: a
    ///   phone that signed in and never opened a vault has no vaults
    ///   directory, and reporting that as an error would teach the caller to
    ///   ignore the one that matters.
    /// - Throws: `StorageError.Failed` when anything survived. Nothing is
    ///   removed twice by a retry that follows, because removal is idempotent.
    @discardableResult
    func removeAllVaultContent() throws -> Int
}

/// The production remover, over the layout `VaultFiles` owns.
struct VaultContentRemover: VaultContentRemoval {
    private let files: VaultFiles
    private let filesystem: any VaultContentFiles

    /// - Parameters:
    ///   - files: T144's seam, which owns `Application Support/<bundle>/vault`
    ///     and is the only thing that knows where it is.
    ///   - filesystem: the three calls this makes, injected so a refusal is
    ///     reachable. Production passes the default.
    init(files: VaultFiles, filesystem: any VaultContentFiles = SystemVaultContentFiles()) {
        self.files = files
        self.filesystem = filesystem
    }

    @discardableResult
    func removeAllVaultContent() throws -> Int {
        let vaults = try files.vaultsDirectory()
        guard filesystem.exists(at: vaults) else {
            // Never "deleted": this phone has no vault directory, which is what
            // a launch that never opened one looks like, and is also what a
            // second run of a completed sign-out looks like. Saying "removed 0"
            // is the only claim that is true in both.
            Log.storage.notice("no vault directory to remove")
            return 0
        }

        var failures: [any Error] = []
        var removed = 0
        // A directory that exists and cannot be listed is **not an empty one**.
        // Recording the failure rather than treating the listing as `[]` is
        // what stops "could not tell" from reading as "there was nothing
        // there": the container removal below still runs, and this call still
        // reports that something went wrong.
        var children: [URL] = []
        do {
            children = try filesystem.contentsOfDirectory(at: vaults)
        } catch {
            failures.append(Self.failure("could not list the vault directory", error))
        }
        // The children first and the container afterwards. A single
        // `removeItem` on the tree would be one call that either wholly
        // succeeds or partly fails with no way to say which vaults went, and
        // the recovery — run it again — needs the ones that did go to stay
        // gone.
        for child in children {
            do {
                try remove(child)
                removed += 1
            } catch {
                failures.append(error)
            }
        }
        do {
            try remove(vaults)
            removed += 1
        } catch {
            failures.append(error)
        }

        if let first = failures.first {
            Log.storage.error("vault content survived a sign-out", .count(failures.count))
            throw first
        }
        Log.storage.notice("vault content removed", .count(removed))
        return removed
    }

    /// Removes one entry and reads the removal back.
    ///
    /// The read-back is not belt and braces. `FileManager.removeItem` reports
    /// success for work it did not finish on a directory tree, and a delete
    /// that silently failed here leaves note content on a phone the user
    /// believes was wiped — the filesystem twin of `Keychain.delete`'s "a
    /// delete that silently failed leaves key material on a device the user
    /// signed out of".
    private func remove(_ url: URL) throws {
        do {
            try filesystem.removeItem(at: url)
        } catch {
            throw Self.failure("could not remove vault content", error)
        }
        guard !filesystem.exists(at: url) else {
            throw Self.failure("vault content reported as removed is still there")
        }
    }

    private static func failure(_ what: String) -> StorageError {
        .Failed(what: what)
    }

    private static func failure(_ what: String, _ error: any Error) -> StorageError {
        let nsError = error as NSError
        // The domain and the code, never the description: a Foundation
        // filesystem error stringifies with the full path in it.
        return .Failed(what: "\(what) (\(nsError.domain) \(nsError.code))")
    }
}

/// The three filesystem calls a removal makes, behind a protocol for the same
/// reason `FileAttributes` is one: a real filesystem cannot be made to refuse
/// on demand, and the refusal is the arm that decides what a half-completed
/// destruction leaves the user in.
protocol VaultContentFiles: Sendable {
    func exists(at url: URL) -> Bool
    func contentsOfDirectory(at url: URL) throws -> [URL]
    func removeItem(at url: URL) throws
}

/// The real filesystem.
struct SystemVaultContentFiles: VaultContentFiles {
    func exists(at url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func contentsOfDirectory(at url: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: nil,
            // Hidden entries are removed too: a `.DS_Store` beside a database
            // is harmless, but skipping "the ones that start with a dot" is how
            // a directory that looked empty stayed on disk.
            options: []
        )
    }

    func removeItem(at url: URL) throws {
        try FileManager.default.removeItem(at: url)
    }
}
