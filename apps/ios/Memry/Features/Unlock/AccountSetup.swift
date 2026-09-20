import Foundation
import MemryCore
import Observation

// First-device setup: the screen a brand-new account actually needs.
//
// **The bug this closes.** A signed-in phone holding no master key was always
// routed to "Unlock your vault" and asked for 24 words. For an account whose
// setup nobody had finished, those words did not exist — the server answers
// `400 No encryption keys configured` on `/auth/key-verifier` — so a fresh
// signup dead-ended on a screen asking for something that had never been
// created. The state was never read; only the keychain was.
//
// **So the question is asked before the screen is chosen.**
// `key_material_if_configured()` answers `nil` for "this account has no keys
// yet" and throws for everything else, which is the distinction that matters:
// a phone that merely cannot reach the server must **never** be offered a new
// phrase for an account that already has one — that would mint a second master
// key and strand every record written under the first.
//
// **The phrase is shown before it is real, and that is deliberate.** Setup
// publishes `{ kdfSalt, keyVerifier }` only after the user has confirmed three
// words back, so a user who closes the app at the phrase screen has an account
// with no keys — the state they were already in — rather than an account whose
// only key is on a screen they did not read.
//
// **Nothing here logs a word, a key or a salt** (Constitution II). `Log` takes
// a `StaticString` and a closed detail; a count and an error code are all that
// can be said.

/// The account-level half of setup: what the server knows, and what it is told.
///
/// A two-method dependency rather than `AuthSession` itself, so the whole flow
/// can be driven in a test without a network.
protocol AccountSetting: Sendable {
    /// `nil` means the account has no key material yet. Anything else throws.
    func keyMaterialIfConfigured() async throws -> AccountKeyMaterial?
    /// Publishes this account's salt and verifier, once.
    func completeSetup(kdfSaltBase64: String, keyVerifier: String) async throws
}

/// The production implementation over the core's session.
struct CoreAccountSetting: AccountSetting {
    private let session: any AuthSessionProtocol

    init(session: any AuthSessionProtocol) {
        self.session = session
    }

    /// Awaited directly, never through `CoreExecutor`: both calls suspend over
    /// a network round trip (spec-defect 90), and a queued one would park a
    /// queue thread on a semaphore behind the server's latency.
    func keyMaterialIfConfigured() async throws -> AccountKeyMaterial? {
        guard let material = try await session.keyMaterialIfConfigured() else { return nil }
        guard let kdfSalt = Data(base64Encoded: material.kdfSalt) else {
            // The answer arrived and could not be read. A different fact from a
            // refusal, and it must not read as one.
            throw ApiError.MalformedResponse(
                path: "/auth/key-verifier",
                what: "the kdf salt is not base64"
            )
        }
        return AccountKeyMaterial(kdfSalt: kdfSalt, keyVerifier: material.keyVerifier)
    }

    func completeSetup(kdfSaltBase64: String, keyVerifier: String) async throws {
        try await session.completeAccountSetup(
            kdfSaltBase64: kdfSaltBase64,
            keyVerifier: keyVerifier
        )
    }
}

@MainActor
@Observable
final class AccountSetupViewModel {
    /// Where the flow is. `alreadyConfigured` is not a failure and not an end:
    /// it is the answer that sends the phone to the unlock route instead.
    enum Phase: Equatable {
        /// Asking the server which of the two situations this is.
        case checking
        /// This account has no keys. These are the words that will become them.
        case phrase(String)
        /// The words are shown; three of them are being typed back.
        case confirming(String)
        /// Publishing the salt and verifier, and writing the key to this
        /// device. Not cancellable: the Argon2id pass cannot be interrupted
        /// (spec-defect 108) and a half-published account is worse than a wait.
        case establishing
        /// The account is set up and this device holds the key.
        case established
        /// The account already has key material; the phrase route is not this
        /// device's to take.
        case alreadyConfigured
        case failed(UserFacingError)
    }

    private(set) var phase: Phase = .checking

    /// Which words the confirmation asks for, 0-based, ascending.
    ///
    /// Picked once per generated phrase and never re-rolled on a wrong answer:
    /// re-rolling turns a check into a quiz the user can grind past, and the
    /// point is that the phrase left the screen with them.
    private(set) var confirmationIndices: [Int] = []

    private let account: any AccountSetting
    private let secureStore: any SecureStore
    private let executor: CoreExecutor
    /// The Argon2id pass, injected for the one reason `RecoveryPhraseUnlock`
    /// injects it: a 64 MiB allocation failure cannot be produced on demand,
    /// and it must not surface as "wrong phrase".
    private let derive: @Sendable (String, Data) throws -> Data

    init(
        account: any AccountSetting,
        secureStore: any SecureStore,
        executor: CoreExecutor = .shared,
        derive: @escaping @Sendable (String, Data) throws -> Data = {
            try deriveMasterKey(phrase: $0, kdfSalt: $1)
        }
    ) {
        self.account = account
        self.secureStore = secureStore
        self.executor = executor
        self.derive = derive
    }

    /// The generated phrase, or `nil` in every phase that has none.
    var phrase: String? {
        switch phase {
        case let .phrase(words), let .confirming(words): words
        default: nil
        }
    }

    /// Asks the server which situation this is, then generates if it must.
    func begin() async {
        guard phase == .checking else { return }
        do {
            if try await account.keyMaterialIfConfigured() != nil {
                Log.auth.notice("this account already holds key material")
                phase = .alreadyConfigured
                return
            }
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.auth.error("could not tell whether this account has keys", .code(mapped.code))
            // **Not** a new phrase. An unreachable server is not an empty
            // account, and guessing here mints a second master key.
            phase = .failed(mapped)
            return
        }
        let words = generateRecoveryPhrase()
        confirmationIndices = Self.confirmationIndices(
            wordCount: words.split(separator: " ").count
        )
        Log.auth.notice("generated a recovery phrase for a new account")
        phase = .phrase(words)
    }

    /// The user says they have written it down.
    func continueToConfirmation() {
        guard case let .phrase(words) = phase else { return }
        phase = .confirming(words)
    }

    /// Back to the words, because a user who cannot answer needs to read them
    /// again rather than be locked out of their own setup.
    func showPhraseAgain() {
        guard case let .confirming(words) = phase else { return }
        phase = .phrase(words)
    }

    /// Whether one typed answer is the word at that position.
    ///
    /// Case- and whitespace-insensitive, because the user is typing from paper
    /// and the core normalises the same way before deriving.
    func isCorrect(_ typed: String, at index: Int) -> Bool {
        guard let words = phrase?.split(separator: " "), index < words.count else { return false }
        let cleaned = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !cleaned.isEmpty && cleaned == words[index].lowercased()
    }

    /// Derives the key, publishes the account's material, and stores the key.
    ///
    /// **The order is the whole safety property.** Publish first, store second:
    /// a device that stored a key it never published would hold a key the
    /// account does not know about, and every record it wrote would be
    /// unreadable everywhere else. A store that fails after a successful
    /// publish is recoverable — the phrase still opens the account.
    func establish() async {
        guard case let .confirming(words) = phase else { return }
        phase = .establishing
        do {
            let salt = generateKdfSalt()
            let derive = derive
            let masterKey = try await executor.run { try derive(words, salt) }
            let verifier = try accountKeyVerifier(masterKey: masterKey)
            try await account.completeSetup(
                kdfSaltBase64: salt.base64EncodedString(),
                keyVerifier: verifier
            )
            try secureStore.set(key: .masterKey, value: masterKey)
            Log.auth.notice("first-device setup completed")
            phase = .established
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.auth.error("first-device setup failed", .code(mapped.code))
            phase = .failed(mapped)
        }
    }

    /// After a failure: back to the question, not to a new phrase.
    ///
    /// Re-asking the server is the only honest retry. The old phrase may have
    /// been published by the call that appeared to fail, and handing out a
    /// second one would mint a key the account cannot read.
    func startOver() async {
        phase = .checking
        confirmationIndices = []
        await begin()
    }

    /// Three positions, spread out, ascending.
    ///
    /// The gap is not decoration: three adjacent words can be read off one line
    /// of a photo, and the check is supposed to prove the whole phrase left the
    /// screen.
    static func confirmationIndices(wordCount: Int, using generator: () -> Int = { Int.random(in: 0..<1_000_000) }) -> [Int] {
        guard wordCount >= 6 else { return Array(0..<min(wordCount, 3)) }
        let third = wordCount / 3
        return [
            generator() % third,
            third + generator() % third,
            2 * third + generator() % (wordCount - 2 * third)
        ]
    }
}
