import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T153/T154, and **spec-defect 114's closing evidence**.
//
// T235 exported `DeviceLink` and deliberately left 114 open, on the grounds
// that an export with no caller is not done. This file is the caller, and it
// is shaped so that it **fails against a fake that works**:
//
//   * `theScanLeavesThroughTheRealTransport` asserts a `POST` to
//     `/auth/linking/scan` reaches a `URLProtocol` inside the genuine
//     `URLSessionTransport`, from the `DeviceLink` the production composition
//     built. A correct in-memory `DeviceLinkProtocol` answers instantly, issues
//     no request, and fails it.
//   * `anAlreadyLinkedPhoneSpendsNoRequest` reads the master key through the
//     genuine `Keychain` over a `SecItem*` recorder. A working in-memory
//     `SecureStore` produces no `kSecAttrService`-shaped read and fails it.
//
// **No network call is made by this file**, and no staging credential is read:
// `URLProtocol` intercepts inside `URLSession` before a connection exists.
// Nothing under `~/.memry/staging` is touched.

/// Its own class and its own statics, so it cannot interleave with the other
/// `URLProtocol`s in this target.
final class T153StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Seen: Sendable {
        let url: String?
        let method: String?
        /// The request body, read from the **stream** when `httpBody` is nil.
        /// `URLSession` moves a body onto `httpBodyStream` before a
        /// `URLProtocol` ever sees it, so reading only `httpBody` here would
        /// capture `nil` for every request and quietly assert nothing.
        let body: Data?
    }

    static let captured = Mutex<[Seen]>([])

    static func reset() { captured.withLock { $0 = [] } }

    // swiftlint:disable static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    // swiftlint:enable static_over_final_class

    override func startLoading() {
        let body = request.httpBody ?? Self.drain(request.httpBodyStream)
        Self.captured.withLock {
            $0.append(Seen(url: request.url?.absoluteString, method: request.httpMethod, body: body))
        }
        guard let url = request.url else { return }
        let response = HTTPURLResponse(
            url: url, statusCode: 404, httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )
        if let response {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(#"{"code":"LINKING_SESSION_NOT_FOUND","message":"no"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(contentsOf: buffer[0 ..< read])
        }
        return data
    }
}

private func linkStubbedConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionTransport.defaultConfiguration()
    configuration.protocolClasses = [T153StubURLProtocol.self]
    return configuration
}

/// A §3.8 payload that is well-formed all the way through the core's local
/// checks — a UUID `sessionId`, a 32-byte X25519 point, a `linkingSecret` that
/// decodes to exactly 32 bytes (§3.3, the client's own length check), and a
/// window that is still open — so that the next thing the core does is the one
/// request this file is about.
///
/// The "ephemeral public key" is the X25519 base point, which is a real point
/// and not a low-order one. No secret here is anybody's: 32 bytes of a counter.
private func wellFormedInvitation(expiringAt expiresAt: Int) -> String {
    var basePoint = [UInt8](repeating: 0, count: 32)
    basePoint[0] = 9
    let secret = Data((0 ..< 32).map { UInt8($0) }).base64EncodedString()
    return """
    {"sessionId":"6f1d6b1e-0b3f-4f1a-9d3a-7c2f5b8e1a44",\
    "ephemeralPublicKey":"\(Data(basePoint).base64EncodedString())",\
    "linkingSecret":"\(secret)",\
    "expiresAt":\(expiresAt)}
    """
}

@Suite("device linking wiring", .serialized)
struct DeviceLinkWiringTests {
    /// **The whole hop**: `AuthStartup` → `AuthComposition.makeGraph` →
    /// `DeviceLink` → the core's `HttpClient` → the genuine
    /// `URLSessionTransport` → the wire, at chapter 03 §3.1's unauthenticated
    /// new-device route.
    ///
    /// The assertion is the **request**, not the answer. A fake `DeviceLink`
    /// returning a perfect `LinkingScan` satisfies every assertion an "it
    /// links" test can make and leaves this capture list empty, which is the
    /// only shape that separates "wired" from "wired to something else".
    @Test("the scan leaves through the real transport, at chapter 03 §3.1's route")
    @MainActor
    func theScanLeavesThroughTheRealTransport() async throws {
        T153StubURLProtocol.reset()
        let items = SeededKeychainItems(seed: ["refresh-token": "refresh-from-the-last-run"])
        let startup = AuthStartup(
            emitter: CoreEvents().emitter,
            transportConfiguration: linkStubbedConfiguration(),
            keychainItems: items
        )

        await startup.begin()

        // The production object, not a stand-in for one.
        #expect(startup.deviceLink is DeviceLink)
        let model = try #require(startup.linkModel(for: .registered))
        model.typedPayload = wellFormedInvitation(expiringAt: Int(Date().timeIntervalSince1970) + 240)

        // Left to fail: the request has already left by the time the 404 lands.
        await model.submitTypedPayload()

        let seen = try #require(T153StubURLProtocol.captured.withLock { $0.first })
        #expect(seen.url == "https://sync-staging.memrynote.com/auth/linking/scan")
        #expect(seen.method == "POST")
        // **The wire shape, at the end of the real hop** (spec-defect 140).
        // The core pins the same key set in `crates/memry-core/tests/
        // device_link.rs`; this one is here because the two fields that were
        // missing are the only ones in the body the *shell* supplies, and a
        // core test cannot see whether this app ever handed them over.
        // Pinned to `apps/sync-server/src/routes/linking.ts:50-59`, a schema
        // this repository does not own and cannot import.
        let body = try #require(seen.body)
        let fields = try #require(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        #expect(fields.keys.sorted() == [
            "deviceName", "devicePlatform", "linkingSecret", "newDeviceConfirm",
            "newDevicePublicKey", "scanConfirm", "scanProof", "sessionId"
        ])
        // Chapter 02 §2.12's registration enum, which is what `DeviceDescriptor`
        // carries — not `CLIENT_PLATFORMS`, which the same graph also holds.
        #expect(fields["devicePlatform"] as? String == "ios")
        #expect((fields["deviceName"] as? String)?.isEmpty == false)
        // §3.12's 404 is terminal, and it must not read as an expiry or as a
        // malformed code — the three are different facts.
        #expect(model.error?.code == "api.statusRefused")
        #expect(model.phase == .failed)
    }

    /// The T154 edge, on the production graph and through the **real**
    /// keychain: a phone that already holds the master key resolves to its
    /// existing registration and spends no request at all.
    ///
    /// A duplicate is permanent — the account is at 21 of 50 devices — so the
    /// assertion is that nothing left the phone, not merely that a screen said
    /// something.
    @Test("a phone that already holds the master key links again over nobody's network")
    @MainActor
    func anAlreadyLinkedPhoneSpendsNoRequest() async throws {
        T153StubURLProtocol.reset()
        let items = SeededKeychainItems(seed: [
            "refresh-token": "refresh-from-the-last-run",
            "master-key": "a-master-key-this-phone-already-has"
        ])
        let startup = AuthStartup(
            emitter: CoreEvents().emitter,
            transportConfiguration: linkStubbedConfiguration(),
            keychainItems: items
        )
        await startup.begin()
        let model = try #require(startup.linkModel(for: .registered))

        model.begin()
        model.typedPayload = wellFormedInvitation(expiringAt: Int(Date().timeIntervalSince1970) + 240)
        await model.submitTypedPayload()

        #expect(model.phase == .alreadyLinked)
        #expect(T153StubURLProtocol.captured.withLock { $0.isEmpty })
        // Read through the genuine `Keychain`, with data-model §B's query.
        // Swap it for a working in-memory `SecureStore` and this is empty.
        let read = try #require(items.readAccounts.first { $0.account == "master-key" })
        #expect(read.service == Keychain.service)
    }

    /// §3.3's length check is the **client's**, because the server schema is
    /// only `min(1)`. A 16-byte secret is refused locally, before a request,
    /// and it is not the same fact as a code that was never JSON.
    @Test("a wrong-length linking secret is refused before anything leaves the phone")
    @MainActor
    func aWrongLengthSecretNeverReachesTheServer() async throws {
        T153StubURLProtocol.reset()
        let items = SeededKeychainItems(seed: ["refresh-token": "refresh-from-the-last-run"])
        let startup = AuthStartup(
            emitter: CoreEvents().emitter,
            transportConfiguration: linkStubbedConfiguration(),
            keychainItems: items
        )
        await startup.begin()
        let model = try #require(startup.linkModel(for: .registered))

        let short = Data((0 ..< 16).map { UInt8($0) }).base64EncodedString()
        model.typedPayload = wellFormedInvitation(expiringAt: Int(Date().timeIntervalSince1970) + 240)
            .replacingOccurrences(
                of: Data((0 ..< 32).map { UInt8($0) }).base64EncodedString(),
                with: short
            )

        await model.submitTypedPayload()

        #expect(T153StubURLProtocol.captured.withLock { $0.isEmpty })
        #expect(model.error?.code == "linking.invalidLength")
        #expect(model.phase == .idle)
    }

    /// §3.8: an expired session is refused **before any crypto**, and it is
    /// its own state rather than a refusal of the user's eyesight.
    @Test("an already-expired invitation is refused locally, with its own state")
    @MainActor
    func anExpiredInvitationIsRefusedLocally() async throws {
        T153StubURLProtocol.reset()
        let items = SeededKeychainItems(seed: ["refresh-token": "refresh-from-the-last-run"])
        let startup = AuthStartup(
            emitter: CoreEvents().emitter,
            transportConfiguration: linkStubbedConfiguration(),
            keychainItems: items
        )
        await startup.begin()
        let model = try #require(startup.linkModel(for: .registered))

        model.typedPayload = wellFormedInvitation(expiringAt: Int(Date().timeIntervalSince1970) - 1)
        await model.submitTypedPayload()

        #expect(T153StubURLProtocol.captured.withLock { $0.isEmpty })
        #expect(model.error?.code == "linking.sessionExpired")
        #expect(model.phase == .expired)
    }
}
