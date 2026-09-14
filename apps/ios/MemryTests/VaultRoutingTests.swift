import Foundation
import MemryCore
import Testing

@testable import Memry

// T155's routing half: which screen a registered device sees.
//
// **The question T152 left open and named T155 as its owner** — "whether an
// already unlocked account should skip the phrase screen". Chapter 01 §1.6
// stores one master key per account and §1.7 derives every vault key from it
// with no per-vault input, so a device that already holds the master key has
// nothing left to unlock and the next question is which vault.
//
// The keychain under the real `Keychain` is substituted, not the `Keychain`
// itself: the mapping under test — "absent" versus "locked" versus "present" —
// is the production one.

/// One scripted `SecItemCopyMatching` answer. Every other call is a failure
/// this test never expects to need.
private struct ScriptedKeychainItems: KeychainItemStore {
    let status: OSStatus
    let data: Data?

    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?) { (status, data) }
    func add(attributes: [String: Any]) -> OSStatus { errSecInternalError }
    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus { errSecInternalError }
    func delete(query: [String: Any]) -> OSStatus { errSecInternalError }
}

/// The account read the unlock screen needs. Never called by these tests — the
/// routing decision is taken before a phrase is entered — so it traps.
private struct UnusedKeyMaterial: AccountKeyMaterialSource {
    func accountKeyMaterial() async throws -> AccountKeyMaterial {
        throw ApiError.MalformedResponse(path: "/auth/key-verifier", what: "not scripted")
    }
}

@MainActor
@Suite("T155 routing after unlock")
struct VaultRoutingTests {
    private func startup(_ items: ScriptedKeychainItems) -> AuthStartup {
        AuthStartup(emitter: CoreEvents().emitter, keyMaterial: UnusedKeyMaterial(), keychainItems: items)
    }

    @Test("a device that already holds the master key has nothing left to unlock")
    func anUnlockedAccountSkipsThePhrase() {
        let held = ScriptedKeychainItems(status: errSecSuccess, data: Data(repeating: 7, count: 32))
        #expect(startup(held).isAlreadyUnlocked())
    }

    @Test("a device with no master key is asked for the phrase")
    func aLockedAccountIsAskedForThePhrase() {
        let absent = ScriptedKeychainItems(status: errSecItemNotFound, data: nil)
        #expect(startup(absent).isAlreadyUnlocked() == false)
        #expect(startup(absent).unlockModel(for: .registered) != nil)
    }

    /// The defect-121 family, one layer down: `errSecInteractionNotAllowed` is a
    /// phone that has not been unlocked since boot, which is "could not tell",
    /// never "there is no key". Reading it as absent would be fine here — the
    /// user just re-enters the phrase — but the screen it leads to ends in a
    /// `SecItemAdd` into the same locked store, so the honest answer is to keep
    /// the phrase screen rather than to claim the account is already unlocked.
    @Test("a keychain that could not be read does not read as an unlocked account")
    func aLockedStoreIsNotAnUnlockedAccount() {
        let locked = ScriptedKeychainItems(status: errSecInteractionNotAllowed, data: nil)
        #expect(startup(locked).isAlreadyUnlocked() == false)
        #expect(startup(locked).unlockModel(for: .registered) != nil)
    }

    @Test("an unregistered device gets neither screen")
    func anUnregisteredDeviceGetsNeitherScreen() {
        let held = ScriptedKeychainItems(status: errSecSuccess, data: Data(repeating: 7, count: 32))
        let root = startup(held)
        #expect(root.unlockModel(for: .signedOut) == nil)
        #expect(root.vaultModel(for: .signedOut) == nil)
    }

    /// The vault picker is built over the session the launch produced. Before
    /// `begin()` there is none, and a picker over no session would be a list
    /// nobody is signed in to read.
    @Test("the vault picker needs the session the launch built")
    func theVaultPickerNeedsASession() {
        let held = ScriptedKeychainItems(status: errSecSuccess, data: Data(repeating: 7, count: 32))
        #expect(startup(held).vaultModel(for: .registered) == nil)
    }
}
