import Foundation
import MemryCore
import Security
import Synchronization
import Testing

@testable import Memry

// T143. Two suites, and the difference between them is the whole honesty of
// this file:
//
// - `KeychainRealStoreTests` drives real `SecItem*` calls against the
//   simulator's keychain. It is the only evidence that the identity, the
//   attributes and the add-or-update path actually work — and it is evidence
//   *for the simulator*, whose keychain is a file-backed stand-in with no
//   Secure Enclave. `AfterFirstUnlockThisDeviceOnly` is stored and read back
//   there as an attribute string; it does not gate anything, because a
//   simulator is never locked. What is worth is that the attribute we asked for
//   is the attribute the item carries. What it is not worth is any claim about
//   device behaviour; that belongs to T161/T162.
//
// - `KeychainStatusMappingTests` substitutes the platform, not the store, and
//   is the only way to reach `errSecInteractionNotAllowed` at all: a simulator
//   cannot be made to return -25308 on demand. So the locked arm is covered at
//   the mapping layer only. That proves `Keychain` turns -25308 into `Locked`
//   and emits the hint; it does not prove the real keychain ever returns -25308
//   here. Nothing short of a locked device proves that.

/// The three things a `get` can be, as one value.
///
/// This type exists so `Locked` and absent are compared **by identity** rather
/// than by truthiness. `#expect(try keychain.get(...) == nil)` passes for one
/// and throws for the other; `== .absent` and `== .failure(.Locked)` are two
/// distinct cases of one `Equatable` enum, and a test can assert both that a
/// result *is* one and *is not* the other.
private enum GetOutcome: Equatable {
    case value(Data)
    case absent
    case failure(SecureStoreError)

    var deniedReason: String? {
        if case .failure(.Denied(let what)) = self { return what }
        return nil
    }

    var failedReason: String? {
        if case .failure(.Failed(let what)) = self { return what }
        return nil
    }
}

private func outcome(of keychain: Keychain, _ key: SecureStoreKey) -> GetOutcome {
    do {
        guard let data = try keychain.get(key: key) else { return .absent }
        return .value(data)
    } catch let error as SecureStoreError {
        return .failure(error)
    } catch {
        return .failure(.Failed(what: "unexpected error type"))
    }
}

/// data-model §B's table, restated here rather than imported, so a change to
/// `Keychain.account(for:)` has to be made twice and the second time is this
/// test failing.
private let contract: [(key: SecureStoreKey, account: String)] = [
    (.masterKey, "master-key"),
    (.deviceSigningKey, "device-signing-key"),
    (.accessToken, "access-token"),
    (.refreshToken, "refresh-token"),
    (.setupToken, "setup-token")
]

/// 32 bytes that are **not** valid UTF-8, so a `String` round trip anywhere in
/// the path would either fail or corrupt them, and base64 would be 44 bytes.
private let rawKeyBytes = Data([0xFF, 0xFE, 0x00, 0x80, 0xC0, 0xAF] + Array(repeating: 0x7F, count: 26))

@Suite("Keychain over the real keychain", .serialized)
struct KeychainRealStoreTests {
    private let hub = CoreEvents()
    private let keychain: Keychain

    /// `.serialized` plus this: the simulator keychain is process-wide state,
    /// so every test starts from empty. A failure here is the entitlement
    /// problem (-34018), not a mapping problem.
    init() throws {
        keychain = Keychain(emitter: hub.emitter)
        try keychain.clear()
    }

    @Test("a value round-trips byte for byte, and is stored as those bytes")
    func roundTripsRawBytes() throws {
        try keychain.set(key: .masterKey, value: rawKeyBytes)

        #expect(outcome(of: keychain, .masterKey) == .value(rawKeyBytes))

        // Read around `Keychain` entirely: what is in the item is what the core
        // handed over. 32 bytes, not base64's 44, and not decodable as text.
        let stored = rawData("master-key")
        #expect(stored == rawKeyBytes)
        #expect(stored?.count == 32)
        #expect(stored.flatMap { String(data: $0, encoding: .utf8) } == nil)
    }

    @Test("each of the five sits under §B's service and account, after first unlock, this device only")
    func storesEveryEntryUnderTheContractedIdentity() throws {
        for (index, entry) in contract.enumerated() {
            let value = Data([UInt8(index), 0xFF, 0x00])
            try keychain.set(key: entry.key, value: value)

            #expect(rawData(entry.account) == value, "\(entry.account)")
            #expect(
                rawAttributes(entry.account)?[kSecAttrAccessible as String] as? String
                    == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
                "\(entry.account)"
            )
            // Asked for as a query rather than read as an attribute: a
            // synchronizable query must not find a non-synchronizable item.
            #expect(
                rawQuery(entry.account, [kSecAttrSynchronizable as String: true]).status
                    == errSecItemNotFound,
                "\(entry.account)"
            )
        }
    }

    @Test("a second set overwrites in place rather than failing or duplicating")
    func secondSetOverwrites() throws {
        try keychain.set(key: .accessToken, value: Data([0x01, 0x02]))
        try keychain.set(key: .accessToken, value: Data([0x03, 0x04, 0x05]))

        #expect(outcome(of: keychain, .accessToken) == .value(Data([0x03, 0x04, 0x05])))

        let all = rawQuery("access-token", [
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ])
        #expect((all.result as? [Data])?.count == 1)
    }

    @Test("an overwrite re-asserts the access policy on an entry an older build wrote weakly")
    func overwriteCorrectsAWeakerAccessClass() throws {
        let added = SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Keychain.service,
            kSecAttrAccount as String: "device-signing-key",
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: Data([0x09])
        ] as CFDictionary, nil)
        #expect(added == errSecSuccess)

        try keychain.set(key: .deviceSigningKey, value: rawKeyBytes)

        #expect(
            rawAttributes("device-signing-key")?[kSecAttrAccessible as String] as? String
                == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
        #expect(outcome(of: keychain, .deviceSigningKey) == .value(rawKeyBytes))
    }

    @Test("an entry that was never written reads as absent")
    func missingEntryIsAbsent() {
        #expect(outcome(of: keychain, .setupToken) == .absent)
    }

    @Test("deleting twice is not an error, and leaves nothing")
    func deleteIsIdempotent() throws {
        try keychain.set(key: .refreshToken, value: Data([0xAB]))
        try keychain.delete(key: .refreshToken)
        try keychain.delete(key: .refreshToken)

        #expect(outcome(of: keychain, .refreshToken) == .absent)
        #expect(rawData("refresh-token") == nil)
    }

    @Test("clear removes every one of the five, with nothing left behind")
    func clearRemovesEveryEntry() throws {
        for entry in contract {
            try keychain.set(key: entry.key, value: Data([0x42]))
            #expect(rawData(entry.account) != nil, "\(entry.account)")
        }

        try keychain.clear()

        for entry in contract {
            #expect(outcome(of: keychain, entry.key) == .absent, "\(entry.account)")
            #expect(rawData(entry.account) == nil, "\(entry.account)")
        }
    }

    // MARK: - Reading around the seam

    private func rawQuery(_ account: String, _ extra: [String: Any]) -> (status: OSStatus, result: CFTypeRef?) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Keychain.service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true
        ]
        query.merge(extra) { _, new in new }

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }

    private func rawData(_ account: String) -> Data? {
        let found = rawQuery(account, [
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ])
        guard found.status == errSecSuccess else { return nil }
        return found.result as? Data
    }

    private func rawAttributes(_ account: String) -> [String: Any]? {
        let found = rawQuery(account, [
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ])
        guard found.status == errSecSuccess else { return nil }
        return found.result as? [String: Any]
    }
}

@Suite("Keychain status mapping", .timeLimit(.minutes(1)))
struct KeychainStatusMappingTests {
    @Test("a locked read is Locked and is not absent")
    func lockedIsNotAbsent() {
        let locked = outcome(of: keychain(.init(copy: errSecInteractionNotAllowed)).store, .masterKey)
        let missing = outcome(of: keychain(.init(copy: errSecItemNotFound)).store, .masterKey)

        #expect(locked == .failure(.Locked))
        #expect(locked != .absent)
        #expect(missing == .absent)
        #expect(locked != missing)
    }

    @Test("a locked read emits exactly one secureStoreLocked hint")
    func lockedReadEmitsTheHint() async {
        let built = keychain(.init(copy: errSecInteractionNotAllowed))
        let stream = built.hub.consume()
        #expect(stream != nil)

        _ = outcome(of: built.store, .masterKey)
        // The sentinel is how "exactly one" is asserted: the whole history is
        // compared, so a missing hint, a duplicated hint and a hint with the
        // wrong scope are three different failures rather than one timeout.
        built.hub.emitter.emit(CoreEvent(.scenePhase))
        built.hub.finish()

        #expect(await collected(stream) == [CoreEvent(.secureStoreLocked), CoreEvent(.scenePhase)])
    }

    @Test("an absent entry emits nothing")
    func absentReadEmitsNothing() async {
        let built = keychain(.init(copy: errSecItemNotFound))
        let stream = built.hub.consume()

        #expect(outcome(of: built.store, .masterKey) == .absent)
        built.hub.emitter.emit(CoreEvent(.scenePhase))
        built.hub.finish()

        #expect(await collected(stream) == [CoreEvent(.scenePhase)])
    }

    @Test("a refusal is Denied, carries the status number, and names no entry")
    func refusalsAreDenied() {
        let refusals: [OSStatus] = [
            errSecAuthFailed, errSecUserCanceled, errSecInteractionRequired, errSecMissingEntitlement
        ]
        for status in refusals {
            let result = outcome(of: keychain(.init(copy: status)).store, .masterKey)
            #expect(result != .absent, "\(status)")
            #expect(result.deniedReason?.contains("\(status)") == true, "\(status)")
            #expect(result.deniedReason?.contains("master-key") == false, "\(status)")
        }
    }

    @Test("an unanticipated status is a failure, never absent")
    func unknownStatusesNeverLookAbsent() {
        let unknown: [OSStatus] = [errSecNotAvailable, errSecDecode, errSecParam, -99_999, errSecIO]
        for status in unknown {
            let result = outcome(of: keychain(.init(copy: status)).store, .masterKey)
            #expect(result != .absent, "\(status)")
            #expect(result.failedReason?.contains("\(status)") == true, "\(status)")
        }
    }

    @Test("success with no payload is a failure, not an empty entry")
    func successWithoutDataIsNotAbsent() {
        let result = outcome(of: keychain(.init(copy: errSecSuccess, copyData: nil)).store, .masterKey)

        #expect(result != .absent)
        #expect(result.failedReason != nil)
    }

    @Test("set falls back to update on a duplicate, re-asserting value and access policy")
    func setIsAddOrUpdate() throws {
        let built = keychain(.init(add: errSecDuplicateItem, update: errSecSuccess))

        try built.store.set(key: .masterKey, value: rawKeyBytes)

        let calls = built.items.calls
        #expect(calls.map(\.operation) == ["add", "update"])
        #expect(calls.last?.account == "master-key")
        #expect(calls.last?.value == rawKeyBytes)
        #expect(calls.last?.accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    @Test("a locked write is Locked, whether the add or the update hit it")
    func lockedWritesAreLocked() {
        let onAdd = keychain(.init(add: errSecInteractionNotAllowed)).store
        #expect(throws: SecureStoreError.Locked) { try onAdd.set(key: .masterKey, value: rawKeyBytes) }

        let onUpdate = keychain(.init(add: errSecDuplicateItem, update: errSecInteractionNotAllowed)).store
        #expect(throws: SecureStoreError.Locked) { try onUpdate.set(key: .masterKey, value: rawKeyBytes) }
    }

    @Test("delete forgives a missing entry and reports everything else")
    func deleteReportsRealFailures() throws {
        try keychain(.init(delete: errSecItemNotFound)).store.delete(key: .setupToken)

        let locked = keychain(.init(delete: errSecInteractionNotAllowed)).store
        #expect(throws: SecureStoreError.Locked) { try locked.delete(key: .setupToken) }
    }

    @Test("clear attempts all five even after one fails, then reports the failure")
    func clearIsBestEffortAndHonest() {
        let built = keychain(.init(
            delete: errSecSuccess,
            deleteByAccount: ["master-key": errSecInteractionNotAllowed]
        ))

        #expect(throws: SecureStoreError.Locked) { try built.store.clear() }
        #expect(built.items.calls.compactMap(\.account) == contract.map(\.account))
    }

    @Test("clear over an empty store succeeds")
    func clearOverNothingSucceeds() throws {
        try keychain(.init(delete: errSecItemNotFound)).store.clear()
    }

    // MARK: - Building

    /// One `Keychain` over a stubbed platform, with the stub and the hub it
    /// emits into, so a test can assert on all three.
    private struct Built {
        let store: Keychain
        let items: StubItemStore
        let hub: CoreEvents
    }

    private func keychain(_ responses: StubItemStore.Responses) -> Built {
        let hub = CoreEvents()
        let items = StubItemStore(responses)
        return Built(store: Keychain(emitter: hub.emitter, items: items), items: items, hub: hub)
    }

    /// Reads to the end of the stream, which is why every event test calls
    /// `finish()` first.
    ///
    /// Draining a fixed *count* instead is what the first draft did, and it was
    /// wrong in the way that matters: under the mutation that stops the seam
    /// emitting, the expected second element never arrives and the test hangs
    /// rather than fails. That stalled a twenty minute `xcodebuild` and printed
    /// nothing. A test that hangs under the bug it was written for is worse
    /// than no test, because a hang looks like slowness.
    private func collected(_ stream: AsyncStream<CoreEvent>?) async -> [CoreEvent] {
        guard let stream else { return [] }
        var received: [CoreEvent] = []
        for await event in stream {
            received.append(event)
        }
        return received
    }
}

/// Substitutes the platform, not the store: statuses in, statuses out, so the
/// mapping under test is the real one.
private final class StubItemStore: KeychainItemStore {
    struct Responses: Sendable {
        var copy: OSStatus = errSecSuccess
        var copyData: Data? = Data([0x01])
        var add: OSStatus = errSecSuccess
        var update: OSStatus = errSecSuccess
        var delete: OSStatus = errSecSuccess
        var deleteByAccount: [String: OSStatus] = [:]
    }

    struct Call: Sendable, Equatable {
        var operation: String
        var account: String?
        var value: Data?
        var accessible: String?
    }

    private let responses: Responses
    private let recorded = Mutex<[Call]>([])

    init(_ responses: Responses) {
        self.responses = responses
    }

    var calls: [Call] { recorded.withLock { $0 } }

    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        record("copy", query)
        return (responses.copy, responses.copy == errSecSuccess ? responses.copyData : nil)
    }

    func add(attributes: [String: Any]) -> OSStatus {
        record("add", attributes)
        return responses.add
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        record("update", attributes.merging(query) { current, _ in current })
        return responses.update
    }

    func delete(query: [String: Any]) -> OSStatus {
        record("delete", query)
        let account = query[kSecAttrAccount as String] as? String ?? ""
        return responses.deleteByAccount[account] ?? responses.delete
    }

    private func record(_ operation: String, _ fields: [String: Any]) {
        let call = Call(
            operation: operation,
            account: fields[kSecAttrAccount as String] as? String,
            value: fields[kSecValueData as String] as? Data,
            accessible: fields[kSecAttrAccessible as String] as? String
        )
        recorded.withLock { $0.append(call) }
    }
}
