import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T152. The unlock by recovery phrase.
//
// **The core is real here.** `validate_recovery_phrase`, `derive_master_key`,
// `account_key_verifier` and `account_key_verifier_matches` are the exported
// functions themselves, driven with the committed vectors in
// `packages/contracts/test-vectors/bip39-unlock.json`, so the correct-phrase
// test compares against the master key that file pins rather than against
// whatever this build happens to produce. Only two things are substituted: the
// `SecureStore`, which records rather than writes, and — in three tests — the
// Argon2id pass, because an allocation failure at 64 MiB cannot be produced on
// demand and a queue label cannot be observed from inside libsodium.
//
// **What a simulator result here is worth.** The derivation running at all is
// evidence about *this Mac*: `aarch64-apple-ios-sim` runs on the host CPU with
// host memory and links a different libsodium, so a green run says the chain
// phrase → seed → master key → verifier reproduces the committed vectors, and
// says **nothing** about whether a phone can allocate 64 MiB under pressure.
// That question is T082's and it is answered on hardware (`SpikeS4Tests`).
//
// **No phrase reaches a log.** `Log`'s parameter is a `StaticString`, so the
// compiler enforces it; what these tests check is the other half — that no word
// reaches a *sentence*.

@MainActor
@Suite("T152 — unlock by recovery phrase")
struct RecoveryPhraseUnlockTests {
    // MARK: - The committed vectors

    /// `bip39-unlock.json`, `verifiers[0]`: the whole chain FR-019 ships.
    static let phrase = """
    audit vapor excuse note pledge rough bundle start regular burden reveal theme \
    bachelor bag speed print guess session grit first smoke urge save bicycle
    """
    static let kdfSaltHex = "9f8e7d6c5b4a39281706f5e4d3c2b1a0"
    static let masterKeyHex = "9508efd8ccfc879b7623f660224240cc5aa0d70f430a476ef3340eb402cc7241"
    static let accountVerifier = "zidsjTTFT3OGK2WuYyaxWK69NnM+jXwjEeML6buhrII="

    /// `verifiers[3]`: valid BIP39, wrong account. The FR-027 path.
    static let wrongAccountPhrase = """
    zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo \
    zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote
    """

    /// `bip39[2]`: every word real, checksum deliberately wrong.
    static let badChecksumPhrase = """
    audit vapor excuse note pledge rough bundle start regular burden reveal theme \
    bachelor bag speed print guess session grit first smoke urge save zoo
    """

    /// `bip39[3]`: valid 12-word BIP39, which the product still refuses.
    static let twelveWords = "audit vapor excuse note pledge rough bundle start regular burden reveal they"

    /// Not a BIP39 word in any wordlist, and distinctive enough that finding it
    /// in a sentence cannot be a coincidence.
    static let bogusWord = "quarkxyz"

    static var material: AccountKeyMaterial {
        AccountKeyMaterial(kdfSalt: Data(hex: kdfSaltHex), keyVerifier: accountVerifier)
    }

    // MARK: - The whole chain, against the committed vectors

    @Test("the right phrase stores the vector's master key, once, and nothing else")
    func correctPhraseStoresTheMasterKey() async {
        let store = RecordingSecureStore()
        let model = Self.model(store: store)
        model.phrase = Self.phrase

        await model.unlock()

        #expect(model.error == nil)
        #expect(model.isUnlocked)
        // Cleared only on success: after a typo the user needs what they typed.
        #expect(model.phrase.isEmpty)
        #expect(store.writes.count == 1)
        #expect(store.writes.first?.key == .masterKey)
        #expect(store.writes.first?.value == Data(hex: Self.masterKeyHex))
        #expect(store.deletes.isEmpty)
        #expect(store.clears == 0)
    }

    /// FR-027, and the reason the order in `store(_:matching:)` is the feature:
    /// a valid phrase for a different account must leave the secure store
    /// exactly as it found it.
    @Test("a phrase that is valid but not this account's writes nothing at all")
    func wrongAccountPhraseStoresNothing() async {
        let store = RecordingSecureStore()
        let model = Self.model(store: store)
        model.phrase = Self.wrongAccountPhrase

        await model.unlock()

        #expect(model.error?.code == "recovery.verifierMismatch")
        #expect(model.isUnlocked == false)
        #expect(store.writes.isEmpty)
        // The phrase stays in the field; the user may be on the wrong account.
        #expect(model.phrase == Self.wrongAccountPhrase)
    }

    // MARK: - The three failures the task exists to tell apart

    @Test("an unknown word is marked in the field and never printed into the message")
    func unknownWordIsMarkedAndNotEchoed() async {
        let store = RecordingSecureStore()
        let derivations = Mutex<Int>(0)
        let model = Self.model(store: store, derive: { _, _ in
            derivations.withLock { $0 += 1 }
            return Data(repeating: 0, count: 32)
        })
        model.phrase = Self.phrase.replacingOccurrences(of: "excuse", with: Self.bogusWord)

        await model.unlock()

        #expect(model.error?.code == "recovery.unknownWord")
        // Third word. The view highlights it; the sentence does not carry it.
        #expect(model.highlightedWord == 2)
        let text = model.error?.text.lowercased() ?? ""
        #expect(text.contains(Self.bogusWord) == false)
        #expect(text.contains("bachelor") == false)
        // Validation gates derivation (chapter 01 §1.3): no 64 MiB pass is
        // spent on a phrase that was never going to work.
        #expect(derivations.withLock { $0 } == 0)
        #expect(store.writes.isEmpty)
    }

    @Test("a bad checksum is its own error, not an unknown word")
    func badChecksumIsItsOwnError() async {
        let store = RecordingSecureStore()
        let derivations = Mutex<Int>(0)
        let model = Self.model(store: store, derive: { _, _ in
            derivations.withLock { $0 += 1 }
            return Data(repeating: 0, count: 32)
        })
        model.phrase = Self.badChecksumPhrase

        await model.unlock()

        #expect(model.error?.code == "recovery.badChecksum")
        #expect(model.highlightedWord == nil)
        #expect(derivations.withLock { $0 } == 0)
        #expect(store.writes.isEmpty)
    }

    @Test("a valid twelve-word phrase is refused as a word count")
    func twelveWordsAreRefused() async {
        let store = RecordingSecureStore()
        let model = Self.model(store: store)
        model.phrase = Self.twelveWords

        await model.unlock()

        #expect(model.error?.code == "recovery.wrongWordCount")
        #expect(store.writes.isEmpty)
    }

    /// The distinction `CryptoError::OutOfMemory` exists to preserve, and T082
    /// evidenced on hardware: an allocation failure must not tell a user to
    /// re-type a phrase that was correct.
    @Test("an Argon2id out-of-memory reads as memory, never as a phrase problem")
    func outOfMemoryIsNotAWrongPhrase() async {
        let store = RecordingSecureStore()
        let model = Self.model(store: store, derive: { _, _ in
            throw RecoveryError.Crypto(source: .OutOfMemory(requestedBytes: 67_108_864))
        })
        model.phrase = Self.phrase

        await model.unlock()

        #expect(model.error?.code == "crypto.outOfMemory")
        #expect(model.error?.recourse == .retry)
        #expect(model.error?.text.contains("recovery phrase was correct") == true)
        #expect(store.writes.isEmpty)
        #expect(model.isUnlocked == false)
    }

    // MARK: - Where the derivation runs

    /// This screen is `CoreExecutor`'s canonical caller. The assertion is on the
    /// **queue label**, not on `Thread.isMainThread`: a `nonisolated async`
    /// function on this toolchain hops to the global concurrent executor, so a
    /// thread assertion passes with the queue deleted (spec-defect 91).
    @Test("the 64 MiB derivation runs on the core queue, not on the main actor")
    func derivationRunsOnTheCoreQueue() async {
        let label = "com.memry.test.recovery-\(UUID().uuidString)"
        let observed = Mutex<[String]>([])
        let onMain = Mutex<Bool>(true)
        let model = Self.model(
            store: RecordingSecureStore(),
            executor: CoreExecutor(label: label),
            derive: { _, _ in
                observed.withLock { $0.append(String(cString: __dispatch_queue_get_label(nil))) }
                onMain.withLock { $0 = pthread_main_np() != 0 }
                return Data(repeating: 0, count: 32)
            }
        )
        model.phrase = Self.phrase

        await model.unlock()

        #expect(observed.withLock { $0 } == [label])
        #expect(onMain.withLock { $0 } == false)
    }

    // MARK: - The fetch, and the wiring

    @Test("a key-material failure derives nothing and writes nothing")
    func keyMaterialFailureIsInert() async {
        let store = RecordingSecureStore()
        let derivations = Mutex<Int>(0)
        let model = Self.model(
            store: store,
            source: StubKeyMaterialSource(failure: TransportError.Offline),
            derive: { _, _ in
                derivations.withLock { $0 += 1 }
                return Data(repeating: 0, count: 32)
            }
        )
        model.phrase = Self.phrase

        await model.unlock()

        #expect(model.error?.code == "transport.offline")
        #expect(derivations.withLock { $0 } == 0)
        #expect(store.writes.isEmpty)
    }

    /// The production routing, such as it is. `AuthStartup` is the app's own
    /// composition root, and this asserts the branch that reaches this screen —
    /// including that it stays dark while no source of `{kdfSalt, keyVerifier}`
    /// exists, which is today's honest state (chapter 02 §2.7 has no core
    /// export; band B3 is where it lands).
    @Test("the app root routes a registered device to the unlock screen, and only with a source")
    func appRootRoutesRegisteredToUnlock() {
        let withSource = AuthStartup(keyMaterial: StubKeyMaterialSource(material: Self.material))
        #expect(withSource.unlockModel(for: .registered) != nil)
        #expect(withSource.unlockModel(for: .signedOut) == nil)
        #expect(withSource.unlockModel(for: .setupPending) == nil)
        #expect(AuthStartup().unlockModel(for: .registered) == nil)
    }

    // MARK: - Assembly

    static func model(
        store: RecordingSecureStore,
        executor: CoreExecutor = CoreExecutor(label: "com.memry.test.recovery"),
        source: any AccountKeyMaterialSource = StubKeyMaterialSource(material: RecoveryPhraseUnlockTests.material),
        derive: (@Sendable (String, Data) throws -> Data)? = nil
    ) -> RecoveryPhraseViewModel {
        if let derive {
            return RecoveryPhraseViewModel(executor: executor, source: source, secureStore: store, derive: derive)
        }
        // The real core function, which is the default production path.
        return RecoveryPhraseViewModel(executor: executor, source: source, secureStore: store)
    }
}

// MARK: - The substituted halves

/// Records instead of writing. Nothing here reaches the real keychain: what is
/// under test is *whether* a key is stored and in which order, and the real
/// `Keychain` has its own suite for how.
final class RecordingSecureStore: SecureStore, @unchecked Sendable {
    struct Write: Sendable, Equatable {
        let key: SecureStoreKey
        let value: Data
    }

    /// One lock over one value, so a `set` and the `writes` that reads it
    /// cannot interleave.
    struct State: Sendable {
        var writes: [Write] = []
        var deletes: [SecureStoreKey] = []
        var clears = 0
    }

    private let state = Mutex<State>(State())

    var writes: [Write] { state.withLock { $0.writes } }
    var deletes: [SecureStoreKey] { state.withLock { $0.deletes } }
    var clears: Int { state.withLock { $0.clears } }

    func get(key: SecureStoreKey) throws -> Data? { nil }

    func set(key: SecureStoreKey, value: Data) throws {
        state.withLock { $0.writes.append(Write(key: key, value: value)) }
    }

    func delete(key: SecureStoreKey) throws {
        state.withLock { $0.deletes.append(key) }
    }

    func clear() throws {
        state.withLock { $0.clears += 1 }
    }
}

/// Stands in for band B3's account tier: one answer, or one failure.
struct StubKeyMaterialSource: AccountKeyMaterialSource, @unchecked Sendable {
    var material: AccountKeyMaterial?
    var failure: (any Error)?

    init(material: AccountKeyMaterial) {
        self.material = material
    }

    init(failure: any Error) {
        self.failure = failure
    }

    func accountKeyMaterial() async throws -> AccountKeyMaterial {
        if let failure { throw failure }
        return material!
    }
}

extension Data {
    /// Hex as the vector files spell it. A malformed pair fails the test rather
    /// than silently producing a shorter value.
    init(hex: String) {
        let characters = Array(hex)
        var bytes: [UInt8] = []
        bytes.reserveCapacity(characters.count / 2)
        for index in stride(from: 0, to: characters.count, by: 2) {
            bytes.append(UInt8(String(characters[index...index + 1]), radix: 16)!)
        }
        self.init(bytes)
    }
}
