import Foundation
import MemryCore

/// An in-memory `SecureStore` that records the thread each callback runs on and
/// can re-enter the core from inside the callback.
///
/// Not a Keychain implementation and never becomes one: S1 asks what thread
/// Rust calls back on and whether that callback may call back into the core,
/// and a real Keychain would add an unrelated variable.
final class SpikeSecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private let log: SpikeObservationLog

    /// Runs inside the callback, before it returns. Returns a description of
    /// what the re-entrant core call produced, or `nil` for "not attempted".
    private let reentrantProbe: (@Sendable (SecureStoreKey, String) -> String?)?

    init(
        log: SpikeObservationLog,
        seed: [SecureStoreKey: Data] = [:],
        reentrantProbe: (@Sendable (SecureStoreKey, String) -> String?)? = nil
    ) {
        self.log = log
        self.reentrantProbe = reentrantProbe
        for (key, value) in seed { values[Self.name(key)] = value }
    }

    private static func name(_ key: SecureStoreKey) -> String {
        switch key {
        case .masterKey: return "masterKey"
        case .deviceSigningKey: return "deviceSigningKey"
        case .accessToken: return "accessToken"
        case .refreshToken: return "refreshToken"
        case .setupToken: return "setupToken"
        }
    }

    private func observe(_ method: String, _ key: SecureStoreKey) {
        var observation = SpikeCallbackObservation(seam: "SecureStore", method: method)
        observation.reentrantResult = reentrantProbe?(key, method)
        log.record(observation)
    }

    func get(key: SecureStoreKey) throws -> Data? {
        observe("get(\(Self.name(key)))", key)
        lock.lock()
        defer { lock.unlock() }
        return values[Self.name(key)]
    }

    func set(key: SecureStoreKey, value: Data) throws {
        observe("set(\(Self.name(key)))", key)
        lock.lock()
        values[Self.name(key)] = value
        lock.unlock()
    }

    func delete(key: SecureStoreKey) throws {
        observe("delete(\(Self.name(key)))", key)
        lock.lock()
        values.removeValue(forKey: Self.name(key))
        lock.unlock()
    }

    func clear() throws {
        observe("clear", .masterKey)
        lock.lock()
        values.removeAll()
        lock.unlock()
    }
}
