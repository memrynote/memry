import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// First-device setup, driven over scripted answers.
//
// The bug these are written against: a signed-in phone with no master key was
// always asked for a recovery phrase, including on an account that had none. So
// the assertions are about **which question is asked and in what order**, not
// about pixels.

@MainActor
@Suite("Account setup")
struct AccountSetupTests {
    /// A scripted account. Records what it was asked and answers what it was
    /// told to; nothing here has a benign default, because a fake that answers
    /// an unscripted call is how a screen passes a test it should fail.
    private final class ScriptedAccount: AccountSetting, @unchecked Sendable {
        enum Answer {
            case configured(AccountKeyMaterial)
            case notConfigured
            case fails(any Error)
        }

        struct Published: Equatable {
            let kdfSaltBase64: String
            let keyVerifier: String
        }

        private let answer: Answer
        private let setupOutcome: (any Error)?
        let state = Mutex(State())

        struct State {
            var asked = 0
            var published: [Published] = []
        }

        init(_ answer: Answer, setupFails: (any Error)? = nil) {
            self.answer = answer
            setupOutcome = setupFails
        }

        func keyMaterialIfConfigured() async throws -> AccountKeyMaterial? {
            state.withLock { $0.asked += 1 }
            switch answer {
            case let .configured(material): return material
            case .notConfigured: return nil
            case let .fails(error): throw error
            }
        }

        func completeSetup(kdfSaltBase64: String, keyVerifier: String) async throws {
            state.withLock {
                $0.published.append(Published(kdfSaltBase64: kdfSaltBase64, keyVerifier: keyVerifier))
            }
            if let setupOutcome { throw setupOutcome }
        }
    }

    /// A secure store that records writes.
    private final class RecordingStore: SecureStore, @unchecked Sendable {
        let written = Mutex([SecureStoreKey]())

        func get(key: SecureStoreKey) throws -> Data? { nil }
        func set(key: SecureStoreKey, value: Data) throws {
            written.withLock { $0.append(key) }
        }
        func delete(key: SecureStoreKey) throws {}
        func clear() throws {}
    }

    private func model(
        _ answer: ScriptedAccount.Answer,
        account: ScriptedAccount? = nil,
        store: RecordingStore = RecordingStore()
    ) -> (AccountSetupViewModel, ScriptedAccount, RecordingStore) {
        let scripted = account ?? ScriptedAccount(answer)
        let model = AccountSetupViewModel(
            account: scripted,
            secureStore: store,
            executor: .shared,
            // The Argon2id pass, substituted: this suite is about routing, and
            // a real 64 MiB derivation per case buys nothing it asserts. It
            // must still be **32 bytes** — the verifier derivation refuses any
            // other length, which is how a fake shorter key turned up here as a
            // failed setup rather than as a passing test.
            derive: { phrase, salt in
                var key = Data((phrase + salt.base64EncodedString()).utf8)
                key.append(Data(repeating: 0, count: 32))
                return key.prefix(32)
            }
        )
        return (model, scripted, store)
    }

    @Test("An account with no key material is offered a phrase, not asked for one")
    func newAccountGeneratesAPhrase() async {
        let (model, account, _) = model(.notConfigured)
        await model.begin()

        #expect(account.state.withLock { $0.asked } == 1)
        guard case let .phrase(words) = model.phase else {
            Issue.record("expected a generated phrase, got \(model.phase)")
            return
        }
        #expect(words.split(separator: " ").count == 24)
        #expect(model.confirmationIndices.count == 3)
    }

    @Test("An account that already has keys is sent to the unlock route")
    func configuredAccountSkipsSetup() async {
        let material = AccountKeyMaterial(kdfSalt: Data(repeating: 7, count: 16), keyVerifier: "v")
        let (model, _, _) = model(.configured(material))
        await model.begin()

        #expect(model.phase == .alreadyConfigured)
        #expect(model.phrase == nil, "a configured account must never be shown a new phrase")
    }

    @Test("A server that cannot be reached does not mint a phrase")
    func unreachableServerFails() async {
        // The whole reason `keyMaterialIfConfigured` distinguishes `nil` from a
        // throw: guessing here gives an established account a second master key
        // and strands every record written under the first.
        let (model, _, _) = model(.fails(ApiError.Transport(source: .Offline)))
        await model.begin()

        guard case .failed = model.phase else {
            Issue.record("expected a failure, got \(model.phase)")
            return
        }
        #expect(model.phrase == nil)
    }

    @Test("Confirmation checks the words that were shown, case and space blind")
    func confirmationChecksTheRealWords() async {
        let (model, _, _) = model(.notConfigured)
        await model.begin()
        guard let words = model.phrase?.split(separator: " ").map(String.init) else {
            Issue.record("no phrase")
            return
        }
        let index = model.confirmationIndices[0]

        #expect(model.isCorrect("  \(words[index].uppercased()) ", at: index))
        #expect(model.isCorrect("", at: index) == false, "an empty field is never correct")
        #expect(model.isCorrect("definitelynotaword", at: index) == false)
    }

    @Test("Setup publishes before it stores, and stores only the master key")
    func publishHappensBeforeTheKeyIsStored() async {
        let (model, account, store) = model(.notConfigured)
        await model.begin()
        model.continueToConfirmation()
        await model.establish()

        #expect(model.phase == .established)
        let published = account.state.withLock { $0.published }
        #expect(published.count == 1, "setup is published exactly once")
        // 16 bytes, base64: the length rule lives in the core, and a salt of any
        // other length is a key nothing can re-derive.
        #expect(Data(base64Encoded: published[0].kdfSaltBase64)?.count == 16)
        #expect(store.written.withLock { $0 } == [.masterKey])
    }

    @Test("A failed publish leaves no key on the device")
    func failedPublishStoresNothing() async {
        // A device holding a key the account never heard of writes records
        // nothing else can read. The store must stay empty.
        let account = ScriptedAccount(
            .notConfigured,
            setupFails: ApiError.Status(
                status: 409,
                code: "CONFLICT",
                message: "already set up"
            )
        )
        let store = RecordingStore()
        let (model, _, _) = model(.notConfigured, account: account, store: store)
        await model.begin()
        model.continueToConfirmation()
        await model.establish()

        guard case .failed = model.phase else {
            Issue.record("expected a failure, got \(model.phase)")
            return
        }
        #expect(store.written.withLock { $0 }.isEmpty)
    }
}
