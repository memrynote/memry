import Foundation
import MemryCore
import Observation

// T152. Unlocking an account by its 24-word recovery phrase (FR-019, FR-027),
// and `CoreExecutor`'s canonical caller.
//
// **The order is the feature.** data-model §C.2 draws `Unlocking -> Locked` as
// "verifier mismatch; nothing written, nothing partially unlocked", so this
// file checks the account key verifier (chapter 01 §1.4.1) **before** it writes
// the master key, and a wrong phrase therefore leaves the secure store exactly
// as it found it. Moving the write one line earlier is the bug FR-027 names,
// and `RecoveryPhraseTests` fails when it is moved.
//
// **Every core call goes through `CoreExecutor`.** `derive_master_key` is
// Argon2id at 64 MiB and ops 3 (chapter 01 §1.1) and it *blocks* the calling
// thread for the better part of a second on a phone. Marking a wrapper `async`
// would not move it: SE-0461 runs a `nonisolated async` function on the
// caller's actor, so the derivation would freeze the UI on the main actor. The
// serial queue is what moves it, which is why this screen is the task that
// proves that tier rather than the one that assumes it.
//
// **There is no Cancel.** `rust_future_cancel` appears zero times in the
// generated bindings (spec-defect 108) and `CoreExecutor`'s contract is that a
// call cancelled after it starts runs to completion. A button offering to stop
// a derivation already inside libsodium would be a lie.
//
// **No word of the phrase reaches copy or a log** (`DESIGN.md` §"Error copy, in
// detail", spec-defect 96). `RecoveryError.UnknownWord` carries the offending
// word and this file uses it only to compute an **index** into the text the
// user is already looking at; `ErrorMapping` writes the sentence and never
// echoes the word. `Log`'s parameter is a `StaticString`, so the compiler
// enforces the other half.

/// The two server-held values a phrase needs to become a key
/// (chapter 02 §2.7: `GET /auth/recovery-info`, `GET /auth/key-verifier`).
struct AccountKeyMaterial: Sendable, Equatable {
    /// 16 random bytes, chapter 01 §1.1.
    let kdfSalt: Data
    /// The account key verifier **as the server spelled it**, standard base64.
    /// Kept as a string rather than decoded: chapter 01 §1.4.1's comparison is
    /// over the base64 strings, and decoding here would throw away the only
    /// thing the constant-time comparison is defined over.
    let keyVerifier: String
}

/// Where ``AccountKeyMaterial`` comes from.
///
/// **Nothing in this build implements this.** The two routes that answer it are
/// chapter 02 §2.7's, and neither band B1 nor `AuthSession` exports them — the
/// generated Swift has no `recovery-info` and no `key-verifier` call, and
/// `contracts/core-api.md` puts the account tier in band B3 (`Client`/`Vault`),
/// which does not exist yet. The shell must not fetch them itself: that is the
/// protocol, with an access token, a 401 and a refresh behind it, and all of
/// that lives in the core. So this stays a one-method dependency, the screen is
/// complete behind it, and the task that supplies one is the band B3 export
/// T155's vault work depends on. Reported to the orchestrator as a gap.
protocol AccountKeyMaterialSource: Sendable {
    func accountKeyMaterial() async throws -> AccountKeyMaterial
}

@MainActor
@Observable
final class RecoveryPhraseViewModel {
    /// Chapter 01 §1.3: 24 words, and a valid 12-word BIP39 phrase is still
    /// refused because accepting it halves the entropy silently.
    static let expectedWordCount = 24

    /// Held raw and **not** normalised while typing. The five normalisation
    /// steps are the core's (chapter 01 §1.3) and rewriting the field under the
    /// user's cursor is how a paste that was fine comes back looking broken.
    var phrase = ""

    private(set) var isWorking = false
    /// Set only after the master key is in the secure store.
    private(set) var isUnlocked = false
    /// The last user-visible mapped failure. A swallowed one is logged and
    /// leaves this `nil` — "not alerted", never "not known".
    private(set) var error: UserFacingError?
    /// Which typed word `RecoveryError.UnknownWord` named, as an index into
    /// ``typedWords``. The view highlights it; nothing prints it.
    private(set) var highlightedWord: Int?

    private let executor: CoreExecutor
    private let source: any AccountKeyMaterialSource
    private let secureStore: any SecureStore
    private let derive: @Sendable (String, Data) throws -> Data

    /// - Parameter derive: the Argon2id pass, injected for one reason only —
    ///   an allocation failure at 64 MiB cannot be produced on demand, and
    ///   `CryptoError.OutOfMemory` exists precisely so that it does not surface
    ///   as "wrong phrase" (research R3, T082 on hardware). Production passes
    ///   the core's own function, and the tests that matter most use it too.
    init(
        executor: CoreExecutor,
        source: any AccountKeyMaterialSource,
        secureStore: any SecureStore,
        derive: @escaping @Sendable (String, Data) throws -> Data = {
            try deriveMasterKey(phrase: $0, kdfSalt: $1)
        }
    ) {
        self.executor = executor
        self.source = source
        self.secureStore = secureStore
        self.derive = derive
    }

    // MARK: - What the screen shows

    /// The typed words, lowercased and whitespace-split. This is *not* the
    /// core's normalisation — it is only what the counter and the highlight
    /// index are computed over.
    var typedWords: [String] {
        phrase.split(whereSeparator: \.isWhitespace).map { $0.lowercased() }
    }

    /// "18 of 24". A count the user can act on, unlike a duration or a byte
    /// count (`DESIGN.md`).
    var typedWordCount: Int { typedWords.count }

    var canSubmit: Bool { !isWorking && !typedWords.isEmpty }

    /// `DESIGN.md`: "An error with no mapping still renders a title and an
    /// identifying code." Only that one — a stable code under every message is
    /// clutter, and the codes exist for the log.
    var visibleErrorCode: String? {
        guard let error, error.code == ErrorMapping.unrecognised.code else { return nil }
        return error.code.description
    }

    // MARK: - The unlock

    /// Validate, fetch, derive, verify, and only then store.
    ///
    /// Validation comes first because it is local, instant and produces the two
    /// errors a user can actually fix — an unknown word and a bad checksum —
    /// without spending a round trip or a 64 MiB derivation on a phrase that
    /// was never going to work.
    func unlock() async {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        highlightedWord = nil
        defer { isWorking = false }

        do {
            let typed = phrase
            let canonical = try await executor.run { try validateRecoveryPhrase(phrase: typed) }
            let material = try await source.accountKeyMaterial()
            let masterKey = try await derived(from: canonical, using: material)
            try await store(masterKey, matching: material)
            // The field is cleared only on success: after a typo the user needs
            // what they typed, and after an unlock nobody needs it again.
            phrase = ""
            isUnlocked = true
            Log.auth.notice("vault unlocked by recovery phrase")
        } catch {
            record(error)
        }
    }

    private func derived(from canonical: String, using material: AccountKeyMaterial) async throws -> Data {
        let derive = derive
        let salt = material.kdfSalt
        return try await executor.run { try derive(canonical, salt) }
    }

    /// The gate. Throws before it writes, or writes exactly one entry.
    private func store(_ masterKey: Data, matching material: AccountKeyMaterial) async throws {
        let local = try await executor.run { try accountKeyVerifier(masterKey: masterKey) }
        let server = material.keyVerifier
        let matches = try await executor.run { accountKeyVerifierMatches(local: local, server: server) }
        guard matches else {
            // Chapter 02 §2.7.1 permits this to be reported as a phrase that
            // does not match the account, and `ErrorMapping` says exactly that.
            // Nothing has been written, so there is nothing to undo.
            throw RecoveryError.VerifierMismatch
        }
        // Chapter 01 §1.6: the **master key** is what a client stores, one per
        // account, and the vault key is never persisted. Deriving the vault key
        // and binding the local vault key verifier is T155's, at the vault it
        // is opening — there is no vault id here to bind one to.
        //
        // Not on the executor: a `SecItemAdd` is not a core call, and
        // `CoreExecutor` is the path into the core and nothing else.
        try secureStore.set(key: .masterKey, value: masterKey)
    }

    private func record(_ raised: any Error) {
        if let recovery = raised as? RecoveryError, case let .UnknownWord(word) = recovery {
            // The word is used as a needle and dropped. It is eleven bits of
            // the seed and it goes nowhere but this comparison.
            highlightedWord = typedWords.firstIndex(of: word.lowercased())
        }
        let mapped = ErrorMapping.userFacing(raised)
        Log.auth.error("unlock by recovery phrase failed", .code(mapped.code))
        error = mapped.isUserVisible ? mapped : nil
    }
}
