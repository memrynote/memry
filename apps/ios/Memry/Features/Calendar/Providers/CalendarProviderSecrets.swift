import Foundation
import Security

// Spec 007 D4. Calendar provider credentials live only in this iPhone's
// Keychain: a CalDAV app password per account, Google tokens per account.
// Never in a synced row, never in the core, never in UserDefaults, never in
// iCloud Keychain (`ThisDeviceOnly`, not synchronizable). A separate service
// from the sync keys (`com.memry.sync`), so signing out of Memry (which clears
// that service) and a provider disconnect stay independent.

struct CalendarProviderSecrets: Sendable {
    static let service = "com.memry.calendar-providers"
    let store: any KeychainItemStore

    init(store: any KeychainItemStore = SystemKeychainItemStore()) {
        self.store = store
    }

    private func identity(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false
        ]
    }

    func read(_ account: String) -> Data? {
        var query = identity(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = store.copy(query: query)
        return status == errSecSuccess ? data : nil
    }

    @discardableResult
    func write(_ account: String, _ value: Data) -> Bool {
        let query = identity(account)
        let status = store.update(query: query, attributes: [kSecValueData as String: value])
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var attributes = query
        attributes[kSecValueData as String] = value
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return store.add(attributes: attributes) == errSecSuccess
    }

    func delete(_ account: String) {
        _ = store.delete(query: identity(account))
    }

    // MARK: CalDAV

    static func caldavKey(_ accountId: String) -> String { "caldav:\(accountId)" }

    func caldavPassword(_ accountId: String) -> String? {
        read(Self.caldavKey(accountId)).map { String(decoding: $0, as: UTF8.self) }
    }

    func setCaldavPassword(_ accountId: String, _ password: String) -> Bool {
        write(Self.caldavKey(accountId), Data(password.utf8))
    }

    // MARK: Google

    struct GoogleTokens: Codable, Sendable, Equatable {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Date
    }

    static func googleKey(_ email: String) -> String { "google:\(email.lowercased())" }

    func googleTokens(_ email: String) -> GoogleTokens? {
        read(Self.googleKey(email)).flatMap { try? JSONDecoder().decode(GoogleTokens.self, from: $0) }
    }

    func setGoogleTokens(_ email: String, _ tokens: GoogleTokens) -> Bool {
        guard let data = try? JSONEncoder().encode(tokens) else { return false }
        return write(Self.googleKey(email), data)
    }
}
