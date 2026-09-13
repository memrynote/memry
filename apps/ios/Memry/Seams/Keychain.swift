import Foundation
import MemryCore
import Security

/// T143. The `SecureStore` seam over the iOS data-protection keychain
/// (data-model §B, research R11, `contracts/shell-seams.md` §"SecureStore takes
/// bytes").
///
/// **Rust calls this, so it never calls Rust.** Every method here is dispatched
/// by UniFFI synchronously on the calling Rust thread, which may hold the
/// document registry's lock or the connection's. The whole job is to do the
/// platform thing and return; the one thing it says out loud it says through
/// ``CoreEventEmitter``, whose `emit` is synchronous, non-throwing and returns
/// `Void` precisely so there is nothing here to await and nothing to block on.
/// Construct it with an emitter, never with `CoreEvents` and never with
/// `CoreExecutor`.
///
/// **Locked is not absent.** `errSecItemNotFound` is the *only* status that
/// means the entry is not there. Everything else is "could not tell", and
/// `errSecInteractionNotAllowed` in particular is `SecureStoreError.Locked`: a
/// shell that reads "no master key" off a locked device re-registers and throws
/// the master key away (`contracts/shell-seams.md`, the `Locked` row).
///
/// **Bytes, never strings.** Values cross as `Data` exactly as the core handed
/// them over — no base64, no hex, no `String` round trip. The master key is 32
/// raw bytes and the device signing key is 64, and rendering either as a
/// `String` puts a secret in Swift's immutable storage the core cannot zero
/// (constitution 2.1.0, FR-023).
///
/// **Nothing here logs.** Not the value, not the status, not the entry. The
/// typed error carries an `OSStatus` number and nothing else; rendering it for
/// a human is `ErrorMapping.swift`'s job and only its job (Constitution II).
final class Keychain: SecureStore {
    /// data-model §B. One service for all five entries, shared with desktop so
    /// a future tool reads a phone and a Mac with the same vocabulary.
    static let service = "com.memry.sync"

    /// The five, for ``clear()``. Adding a sixth variant to `SecureStoreKey`
    /// breaks ``account(for:)`` at compile time, which is the point of the enum;
    /// remembering to extend this list is the part the compiler cannot do, so
    /// `clearRemovesEveryEntry` writes all five and reads all five back.
    static let allEntries: [SecureStoreKey] = [
        .masterKey, .deviceSigningKey, .accessToken, .refreshToken, .setupToken
    ]

    private let items: any KeychainItemStore
    private let emitter: CoreEventEmitter

    /// - Parameter items: the `SecItem*` family, injected so the status arms the
    ///   simulator cannot be made to produce — `errSecInteractionNotAllowed`
    ///   above all — are still exercised. Production passes the default.
    init(emitter: CoreEventEmitter, items: any KeychainItemStore = SystemKeychainItemStore()) {
        self.emitter = emitter
        self.items = items
    }

    func get(key: SecureStoreKey) throws -> Data? {
        var query = Self.identity(of: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let outcome = items.copy(query: query)
        switch outcome.status {
        case errSecSuccess:
            guard let data = outcome.data else {
                // Success with no payload is a platform contradiction, not an
                // empty entry. Reporting it as absent would be the same lie as
                // reporting a locked device as absent.
                throw failure(from: errSecInternalError, during: "get")
            }
            return data
        case errSecItemNotFound:
            // The only absent.
            return nil
        default:
            throw failure(from: outcome.status, during: "get")
        }
    }

    /// `SecItemAdd` as add-or-update: a second `set` for the same key replaces
    /// the value rather than failing with `errSecDuplicateItem`.
    ///
    /// The update re-asserts `kSecAttrAccessible` as well as the value, so an
    /// entry a previous build wrote under a weaker class is corrected by the
    /// next write rather than kept forever.
    func set(key: SecureStoreKey, value: Data) throws {
        var attributes = Self.identity(of: key)
        attributes[kSecAttrAccessible as String] = Self.accessibility
        attributes[kSecValueData as String] = value

        let added = items.add(attributes: attributes)
        switch added {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let updated = items.update(
                query: Self.identity(of: key),
                attributes: [
                    kSecValueData as String: value,
                    kSecAttrAccessible as String: Self.accessibility
                ]
            )
            guard updated == errSecSuccess else {
                throw failure(from: updated, during: "set")
            }
        default:
            throw failure(from: added, during: "set")
        }
    }

    /// Idempotent: deleting an entry that is not there is what the caller
    /// asked for. Any *other* non-success is reported, because a delete that
    /// silently failed leaves key material on a device the user signed out of.
    func delete(key: SecureStoreKey) throws {
        let status = items.delete(query: Self.identity(of: key))
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw failure(from: status, during: "delete")
        }
    }

    /// Sign-out (FR-025) and the only correct response to an account key
    /// verifier mismatch.
    ///
    /// Best effort *and* honest: every entry is attempted even after one fails,
    /// so a single locked entry cannot strand the other four, and the first
    /// failure is then thrown, so the call cannot report success while an entry
    /// survives.
    func clear() throws {
        var firstFailure: SecureStoreError?
        for key in Self.allEntries {
            let status = items.delete(query: Self.identity(of: key))
            if status == errSecSuccess || status == errSecItemNotFound { continue }
            let error = failure(from: status, during: "clear")
            if firstFailure == nil { firstFailure = error }
        }
        if let firstFailure { throw firstFailure }
    }

    // MARK: - Queries

    /// The core's policy, applied here and not chosen here: readable after the
    /// first unlock so a background refresh before the first unlock after a
    /// reboot can still reach the signing key, and `ThisDeviceOnly` so no key
    /// rides an iCloud keychain backup to a second device (data-model §B).
    ///
    /// Computed rather than stored: a `static let` of a `CFString` is a
    /// non-`Sendable` global under Swift 6, and the alternatives are bridging
    /// it to `String` or marking it unsafe. Reading the framework's own
    /// constant on each call costs nothing and stays honest.
    private static var accessibility: CFString {
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    }

    /// Everything that names one entry, and nothing that reads or writes it.
    /// Used as the add attributes, the update query, the fetch query and the
    /// delete query, so the four cannot drift apart and address different rows.
    ///
    /// No `kSecAttrAccessGroup`: the default group is the app's own, and naming
    /// one here would make the entry unreachable the day the prefix changes.
    private static func identity(of key: SecureStoreKey) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: key),
            kSecUseDataProtectionKeychain as String: true,
            // In a query this restricts the match to non-synchronizable items;
            // in the add attributes it is what keeps the entry out of iCloud.
            kSecAttrSynchronizable as String: false
        ]
    }

    /// data-model §B, verbatim. These strings are read by other Memry clients:
    /// changing one strands a key on every device that already wrote it.
    private static func account(for key: SecureStoreKey) -> String {
        switch key {
        case .masterKey: return "master-key"
        case .deviceSigningKey: return "device-signing-key"
        case .accessToken: return "access-token"
        case .refreshToken: return "refresh-token"
        case .setupToken: return "setup-token"
        }
    }

    // MARK: - Statuses

    /// The whole mapping table, and the seam's only event producer.
    ///
    /// `errSecItemNotFound` never reaches here: absence is decided by the
    /// caller, so a status this function has never heard of cannot become
    /// `nil` by accident. Unknown is `Failed`, which is "could not tell".
    private func failure(from status: OSStatus, during operation: String) -> SecureStoreError {
        if status == errSecInteractionNotAllowed {
            // The hint is about the store, not about the operation, so a write
            // or a delete that hits a locked device says the same thing a read
            // does: the entry exists and is unreadable until first unlock.
            emitter.emit(CoreEvent(.secureStoreLocked))
            return .Locked
        }
        switch status {
        case errSecAuthFailed, errSecUserCanceled,
             errSecInteractionRequired, errSecMissingEntitlement:
            return .Denied(what: Self.describe(status, operation))
        default:
            return .Failed(what: Self.describe(status, operation))
        }
    }

    /// A number and a verb. Never a value byte, never a token, never an entry
    /// name — the core passed the key in, so it already knows which one this
    /// was, and repeating it here would only widen what a log could capture.
    private static func describe(_ status: OSStatus, _ operation: String) -> String {
        "keychain \(operation) failed, OSStatus \(status)"
    }
}

/// The four `SecItem*` calls, behind a protocol for one reason: a simulator
/// cannot be made to return `errSecInteractionNotAllowed` on demand, and that
/// arm is the highest-stakes line in this file.
///
/// Deliberately shaped like the C API rather than like a store — statuses in,
/// statuses out — so that a stub substitutes the *platform*, and the mapping
/// under test is the real one.
protocol KeychainItemStore: Sendable {
    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?)
    func add(attributes: [String: Any]) -> OSStatus
    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus
    func delete(query: [String: Any]) -> OSStatus
}

/// The real keychain.
struct SystemKeychainItemStore: KeychainItemStore {
    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    func add(attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}
