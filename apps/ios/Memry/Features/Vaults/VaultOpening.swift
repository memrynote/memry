import Foundation
import MemryCore

// T155, and **T144's call site** (spec-defect 105).
//
// **Every vault open in this app goes through `VaultFiles.openingVault(_:open:)`
// and this is the only file that calls it.** Nothing in Rust can trigger the
// sidecar sweep: the core opens `data.db` and never calls back, and
// `crates/memry-core/src/seams/storage.rs` has no vocabulary for `-wal` or
// `-shm` at all. So the sweep can only be driven from the Swift side, and a
// convention at the call site is exactly what Phase 3 shipped five times and
// never ran. `openingVault` puts the sweep on the far side of the caller's own
// closure, and ``CoreVaultOpener`` is the one production caller.
//
// **On every open, not only the first.** A clean close deletes `-wal` and
// `-shm`; the next open creates new files, which get new attributes. The write
// -ahead log holds recent note content in plaintext (chapter 12 §12.1's text is
// what lands in it), so an open that skipped the sweep would leave that
// plaintext at whatever class the container default happened to be. Switching
// vaults drops the previous `Vault` handle, which closes its connection, which
// deletes its sidecars — so the *second* open of a vault the user came back to
// is not a hypothetical. `VaultOpeningTests` drives exactly that sequence.
//
// **No key is derived or stored here.** Chapter 01 §1.7: one vault key per
// account, no vault id in the derivation, and the read slice of `Vault`/`Notes`
// holds no key at all because decryption happened at pull time
// (`contracts/core-api.md`). Binding the **local** vault key verifier of
// §1.4.2 is a separate obligation with no home on iOS yet — see the report.

/// The account's vault registry, chapter 05 §5.1.
///
/// A one-method dependency rather than `AuthSessionProtocol` itself, for the
/// reason `AccountKeyMaterialSource` is one: the screen needs the list and
/// nothing else on that object, and a test that wants a scripted list should
/// not have to stub fourteen auth methods to express it.
protocol VaultRegistry: Sendable {
    /// - Returns: every vault on the account. **Empty means empty.** A list
    ///   that could not be read throws; the core refuses to `filter_map` a row
    ///   away, because a reader that did once reported "this account has no
    ///   vaults" against an account holding four.
    func vaults() async throws -> [VaultSummary]
}

/// The production registry: the core's own `GET /sync/vaults`.
struct CoreVaultRegistry: VaultRegistry {
    private let session: any AuthSessionProtocol
    /// The account's master key, read when the list arrives. The registry
    /// holds every vault name sealed under the vault key, so without it a
    /// vault is shown by its placeholder rather than by ciphertext.
    private let masterKey: @Sendable () -> Data?

    init(session: any AuthSessionProtocol, masterKey: @escaping @Sendable () -> Data? = { nil }) {
        self.session = session
        self.masterKey = masterKey
    }

    /// Awaited directly and **not** put on `CoreExecutor` (spec-defect 90):
    /// `vaults()` suspends rather than blocks, and parking a queue thread on a
    /// network round trip would stall every blocking core call behind it.
    func vaults() async throws -> [VaultSummary] {
        // Thrown onward unchanged so `ErrorMapping` sees the real `ApiError`.
        // A 401 the refresh could not rescue must read as an expired session,
        // never as an account with no vaults.
        let rows = try await session.vaults()
        return Self.opened(rows, masterKey: masterKey())
    }

    /// Each sealed name opened, for the rows that carry one.
    ///
    /// A name that does not open stays absent, which the screen draws as
    /// "Unnamed vault". The ciphertext is never offered as a name.
    static func opened(_ rows: [VaultSummary], masterKey: Data?) -> [VaultSummary] {
        rows.map { row in
            guard row.name == nil,
                  let masterKey,
                  let sealed = row.encryptedName,
                  let nonce = row.nameNonce
            else { return row }
            var named = row
            named.name = decryptVaultName(
                masterKey: masterKey,
                vaultId: row.id,
                encryptedName: sealed,
                nameNonce: nonce
            )
            return named
        }
    }
}

/// Opening one vault's local database.
protocol VaultOpening: Sendable {
    func open(_ vaultId: String) async throws -> Vault
}

/// The production opener, and the seam's only caller.
struct CoreVaultOpener: VaultOpening {
    private let files: VaultFiles
    private let executor: CoreExecutor

    init(files: VaultFiles, executor: CoreExecutor) {
        self.files = files
        self.executor = executor
    }

    /// Prepare the directories, open, sweep the sidecars — in that order,
    /// with no way for this function to skip the third.
    ///
    /// `Vault.open` **blocks**: it runs the forward-only migrations, so its
    /// cost is a disk write rather than a round trip (`core-api.md`, the read
    /// slice). That is precisely what `CoreExecutor` is for, and it is why the
    /// call is not simply awaited. There is no Cancel over it either:
    /// `rust_future_cancel` appears zero times in the bindings (spec-defect
    /// 108), and a blocking call never had anything to cancel.
    ///
    /// The connection is still open when the closure returns, which is what
    /// makes the sweep find the `-wal` and `-shm` files rather than report
    /// success over an empty directory.
    func open(_ vaultId: String) async throws -> Vault {
        try await files.openingVault(vaultId) { directory in
            let path = directory.path
            let vault = try await executor.run { try Vault.open(vaultId: vaultId, directory: path) }
            // Where a cached attachment's relative `local_path` lives. Unset,
            // every picture resolved under the temp directory and read as
            // "could not be opened" over bytes that were on disk.
            AttachmentPaths.imagesDirectory = directory
                .appendingPathComponent(VaultFiles.imagesDirectoryName, isDirectory: true)
            return vault
        }
    }
}
