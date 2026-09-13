import Foundation
import MemryCore
import Security
import Synchronization
import Testing

@testable import Memry

// T147, the half that matters most: **is the app talking to the core, or to a
// fake?**
//
// Phase 3 shipped five tiers that were implemented, tested behind fakes, and
// never called, and every one of them passed the whole unit suite. So nothing
// here substitutes a seam. The genuine `Keychain` and the genuine
// `URLSessionTransport` are constructed by the genuine `AuthComposition` and
// handed to a genuine `AuthSession`, and only the **platform underneath them**
// is replaced: a `URLProtocol` in place of the network, a recorder in place of
// `SecItem*`. What is under test is therefore the real object graph, the real
// query construction and the real base URL.
//
// **No network call is made by this file.** `URLProtocol` intercepts inside
// `URLSession` before a connection exists, and the one test that uses no stub
// at all makes no request.

// MARK: - The platform, replaced

/// Its own class, with its own statics, so it cannot interleave with
/// `StubURLProtocol` in `TransportTests.swift`.
final class SignInStubURLProtocol: URLProtocol, @unchecked Sendable {
    static let captured = Mutex<[URLRequest]>([])
    static let status = Mutex<Int>(429)

    static func reset(status code: Int) {
        captured.withLock { $0 = [] }
        status.withLock { $0 = code }
    }

    // swiftlint:disable static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    // swiftlint:enable static_over_final_class

    override func startLoading() {
        Self.captured.withLock { $0.append(request) }
        guard let url = request.url else { return }
        let code = Self.status.withLock { $0 }
        let response = HTTPURLResponse(
            url: url, statusCode: code, httpVersion: "HTTP/1.1",
            // No `retry-after`, so the core's `retryOn429` ladder uses its own
            // 2/4/8 second backoff rather than a server-supplied window. This
            // test never lets it run: it asserts on the **first** request.
            headerFields: ["content-type": "application/json"]
        )
        if let response {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(#"{"code":"RATE_LIMITED","message":"no"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Stands in for `SecItem*`, shaped like the C API so the **real** `Keychain`'s
/// query construction is what runs.
final class RecordingKeychainItems: KeychainItemStore, @unchecked Sendable {
    struct Seen: Sendable, Equatable {
        let operation: String
        let account: String
        let service: String
        let dataProtection: Bool
        let synchronizable: Bool
        let accessible: String?
    }

    private let seen = Mutex<[Seen]>([])
    private let stored = Mutex<[String: Data]>([:])
    private let locked: Set<String>

    /// - Parameter locked: accounts whose read answers `errSecInteractionNotAllowed`
    ///   — the status a simulator cannot be made to produce, and the one arm of
    ///   the seam that emits an event.
    init(locked: Set<String> = []) {
        self.locked = locked
    }

    var history: [Seen] { seen.withLock { $0 } }

    private func record(_ operation: String, _ query: [String: Any]) -> String {
        let account = (query[kSecAttrAccount as String] as? String) ?? "<none>"
        seen.withLock {
            $0.append(Seen(
                operation: operation,
                account: account,
                service: (query[kSecAttrService as String] as? String) ?? "<none>",
                dataProtection: (query[kSecUseDataProtectionKeychain as String] as? Bool) ?? false,
                synchronizable: (query[kSecAttrSynchronizable as String] as? Bool) ?? true,
                accessible: (query[kSecAttrAccessible as String]).map { String(describing: $0) }
            ))
        }
        return account
    }

    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        let account = record("copy", query)
        if locked.contains(account) { return (errSecInteractionNotAllowed, nil) }
        guard let data = stored.withLock({ $0[account] }) else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data)
    }

    func add(attributes: [String: Any]) -> OSStatus {
        let account = record("add", attributes)
        guard let value = attributes[kSecValueData as String] as? Data else { return errSecParam }
        return stored.withLock { table in
            guard table[account] == nil else { return errSecDuplicateItem }
            table[account] = value
            return errSecSuccess
        }
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        let account = record("update", query)
        guard let value = attributes[kSecValueData as String] as? Data else { return errSecParam }
        stored.withLock { $0[account] = value }
        return errSecSuccess
    }

    func delete(query: [String: Any]) -> OSStatus {
        let account = record("delete", query)
        return stored.withLock { $0.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess }
    }
}

// MARK: - The wiring

@Suite("T147 sign-in wiring", .serialized)
struct SignInWiringTests {
    private static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionTransport.defaultConfiguration()
        configuration.protocolClasses = [SignInStubURLProtocol.self]
        return configuration
    }

    @MainActor
    private static func device() throws -> DeviceDescriptor {
        // Chapter 11 §11.2's grammar: a numeric triple, optional `+build`.
        try AuthComposition.device(appVersion: "0.1.0+t147")
    }

    /// The base URL is not hard-coded anywhere in the core's caller: it comes
    /// from `SyncEnvironment`, crosses the constructor, and comes back out on
    /// the wire. Point the composition at `.local` and this fails.
    @Test("the core builds its request against the staging base URL and sends it through the real transport")
    @MainActor
    func coreReachesTheRealTransport() async throws {
        // 400 rather than 429 or 5xx: those two are the statuses the core's own
        // ladder retries, and this test wants one request, not four.
        SignInStubURLProtocol.reset(status: 400)
        let events = CoreEvents()
        let session = try AuthComposition.makeSession(
            environment: .staging,
            device: Self.device(),
            emitter: events.emitter,
            transportConfiguration: Self.configuration(),
            keychainItems: RecordingKeychainItems()
        )

        // Left to fail rather than awaited to success; the assertion is about
        // the request leaving the shell, which has already happened.
        _ = try? await session.requestEmailCode(email: "wiring@example.invalid")

        let first = try #require(SignInStubURLProtocol.captured.withLock { $0.first })
        #expect(first.url?.absoluteString == "https://sync-staging.memrynote.com/auth/otp/request")
        #expect(first.httpMethod == "POST")
        // Nothing here is prod, and nothing fell back to localhost.
        #expect(first.url?.host() == "sync-staging.memrynote.com")
    }

    /// `verify_email_code` commits a device public key (chapter 02 §2.5), so
    /// the signing key is read or minted **through the seam** before any
    /// request is built. Swap the real `Keychain` for anything else and no
    /// `SecItem`-shaped query with Memry's service and accessibility class
    /// appears.
    @Test("the core reaches the real Keychain, with data-model §B's query")
    @MainActor
    func coreReachesTheRealKeychain() async throws {
        SignInStubURLProtocol.reset(status: 400)
        let events = CoreEvents()
        let items = RecordingKeychainItems()
        let session = try AuthComposition.makeSession(
            environment: .staging,
            device: Self.device(),
            emitter: events.emitter,
            transportConfiguration: Self.configuration(),
            keychainItems: items
        )

        _ = try? await session.requestEmailCode(email: "wiring@example.invalid")
        _ = try? await session.verifyEmailCode(code: "123456")

        let signingKey = items.history.filter { $0.account == "device-signing-key" }
        #expect(!signingKey.isEmpty)
        let written = try #require(signingKey.first { $0.operation == "add" })
        #expect(written.service == Keychain.service)
        #expect(written.dataProtection)
        #expect(!written.synchronizable)
        #expect(written.accessible == String(describing: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly))
    }

    /// The whole hop: Rust calls the Swift seam, the seam emits into the hub
    /// **without re-entering the core**, and the hub delivers it.
    ///
    /// Drained by sentinel-and-`finish()` rather than by a fixed count: a
    /// fixture that awaits N elements **hangs** instead of failing when the
    /// yield is missing (spec-defect 99), and a hang looks like slowness.
    @Test("a locked keychain reaches the event hub through the real seam")
    @MainActor
    func lockedKeychainReachesTheHub() async throws {
        SignInStubURLProtocol.reset(status: 400)
        let events = CoreEvents()
        let session = try AuthComposition.makeSession(
            environment: .staging,
            device: Self.device(),
            emitter: events.emitter,
            transportConfiguration: Self.configuration(),
            keychainItems: RecordingKeychainItems(locked: ["device-signing-key"])
        )

        // `verify_email_code` refuses before it touches the store unless a code
        // was requested first, so the address is set here. Without this the
        // seam is never called and the test passes for the wrong reason.
        _ = try? await session.requestEmailCode(email: "wiring@example.invalid")
        _ = try? await session.verifyEmailCode(code: "123456")

        let sentinel = CoreEvent(.scenePhase)
        events.emitter.emit(sentinel)
        events.finish()
        var history: [CoreEvent] = []
        for await event in try #require(events.consume()) { history.append(event) }

        #expect(history == [CoreEvent(.secureStoreLocked), sentinel])
    }

    @Test("this phone identifies itself as iOS, and a bundle with no version refuses to")
    @MainActor
    func deviceDescriptor() throws {
        let descriptor = try AuthComposition.device()
        #expect(descriptor.platform == .ios)
        #expect(!descriptor.appVersion.isEmpty)
        #expect(!descriptor.name.isEmpty)
        // Chapter 02 §2.3: absent means the server's `default`. Picking one is
        // T155's, after registration.
        #expect(descriptor.vaultId == nil)
        // Chapter 11 §11.2's list, not chapter 02 §2.12's. They coincide for a
        // phone and are different enums.
        #expect(AuthComposition.clientPlatform == "ios")

        #expect(throws: ApiError.self) {
            _ = try AuthComposition.device(appVersion: "")
        }

        // Chapter 11 §11.2 rejects a pre-release identifier, and the core does
        // the rejecting: a `MARKETING_VERSION` of "1.0.0-beta" cannot build a
        // session at all. It fails at construction, loudly, rather than being
        // discovered as an opaque 400 at device registration.
        #expect(throws: ApiError.self) {
            _ = try AuthComposition.makeSession(
                environment: .staging,
                device: AuthComposition.device(appVersion: "1.0.0-beta"),
                emitter: CoreEvents().emitter,
                transportConfiguration: Self.configuration(),
                keychainItems: RecordingKeychainItems()
            )
        }
    }

    /// The production entry point, with **nothing** substituted: the real
    /// environment resolution, the real `Keychain` over the simulator's own
    /// keychain, the real `URLSessionTransport`. It makes no request — building
    /// a session and reading its state are both local — so this is the
    /// narrowest possible proof that the app reaches the core at launch.
    @Test("the app root constructs a real session rather than a scaffold")
    @MainActor
    func appRootConstructsASession() async {
        let startup = AuthStartup()
        await startup.begin()

        guard case let .ready(model) = startup.phase else {
            Issue.record("the app root did not reach the core: \(startup.phase)")
            return
        }
        // Nobody has signed in, and the state is the core's answer rather than
        // a default this side picked.
        #expect(model.state == .signedOut)
        #expect(model.step.primary == .sendCode)
        #expect(model.error == nil)
    }
}
