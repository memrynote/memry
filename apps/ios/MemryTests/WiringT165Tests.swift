import Foundation
import MemryCore
import Security
import Synchronization
import Testing

@testable import Memry

// T165. **Is the app talking to the core, or to something that behaves like
// it?**
//
// T148 and T152 were committed, fully tested, and dark: the unlock screen's
// account read was `nil` in production and the Google flow had no button,
// because nothing exported could answer either (spec-defect 114). T163 exported
// both halves. This file is the proof that a production path now spends them,
// and it is shaped so that it **fails against a fake that works**:
//
//   * `keyMaterialLeavesThroughTheRealTransport` asserts a `GET` to
//     `/auth/key-verifier` reaches a `URLProtocol` inside the genuine
//     `URLSessionTransport`. A correct in-memory `AccountKeyMaterialSource`
//     answers instantly, issues no request, and fails this.
//   * `theTokenExchangeLeavesThroughTheOneTransport` asserts the Google token
//     exchange reaches the same seam. A working stub closure fails it.
//   * `aRestoredLaunchReachesTheUnlockScreen` drives the genuine `AuthStartup`
//     over a `SecItem*` recorder holding a refresh token. A working in-memory
//     `SecureStore` in place of the real `Keychain` produces no
//     `kSecAttrService`-shaped read and fails it.
//
// **No network call is made by this file**, and no staging credential is read.
// `URLProtocol` intercepts inside `URLSession` before a connection exists.

// MARK: - The platform, replaced

/// Its own class and its own statics, so it cannot interleave with the two
/// other `URLProtocol`s in this target.
final class T165StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Seen: Sendable {
        let url: String?
        let method: String?
        let body: String?
    }

    static let captured = Mutex<[Seen]>([])
    static let status = Mutex<Int>(400)
    static let payload = Mutex<String>(#"{"code":"AUTH_INVALID_TOKEN","message":"no"}"#)

    static func reset(status code: Int, body: String) {
        captured.withLock { $0 = [] }
        status.withLock { $0 = code }
        payload.withLock { $0 = body }
    }

    // swiftlint:disable static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    // swiftlint:enable static_over_final_class

    override func startLoading() {
        // `URLProtocol` strips the body into a stream, so it is read back here
        // rather than off `httpBody`, which is `nil` by the time this runs.
        let body = request.httpBody.flatMap { String(bytes: $0, encoding: .utf8) }
            ?? Self.streamedBody(of: request)
        Self.captured.withLock {
            $0.append(Seen(url: request.url?.absoluteString, method: request.httpMethod, body: body))
        }
        guard let url = request.url else { return }
        let response = HTTPURLResponse(
            url: url, statusCode: Self.status.withLock { $0 }, httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )
        if let response {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(Self.payload.withLock { $0 }.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func streamedBody(of request: URLRequest) -> String? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var bytes = [UInt8]()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            bytes.append(contentsOf: buffer[0 ..< read])
        }
        return bytes.isEmpty ? nil : String(bytes: bytes, encoding: .utf8)
    }
}

private func stubbedConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionTransport.defaultConfiguration()
    configuration.protocolClasses = [T165StubURLProtocol.self]
    return configuration
}

// MARK: - T152's account read

/// Answers `keyMaterial()` from a script and traps on everything else.
///
/// It exists for the two assertions above, which are about **translation**, not
/// about wiring. The wiring assertion is the one that refuses a fake.
private final class ScriptedKeyMaterial: AuthSessionProtocol, @unchecked Sendable {
    private let answer: KeyMaterial
    init(answer: KeyMaterial) { self.answer = answer }

    func keyMaterial() async throws -> KeyMaterial { answer }
    func keyMaterialIfConfigured() async throws -> KeyMaterial? { answer }
    func completeAccountSetup(kdfSaltBase64: String, keyVerifier: String) async throws {
        throw NotScripted()
    }

    func state() -> AuthState { .signedOut }
    func vaults() async throws -> [VaultSummary] { throw NotScripted() }
    func markRevoked() throws -> AuthState { throw NotScripted() }
    func refresh() async throws -> AuthState { throw NotScripted() }
    func registerDevice() async throws -> AuthState { throw NotScripted() }
    func renewSetupToken() async throws -> AuthState { throw NotScripted() }
    func requestEmailCode(email: String) async throws -> AuthState { throw NotScripted() }
    func resendEmailCode() async throws { throw NotScripted() }
    func restore() throws -> AuthState { throw NotScripted() }
    func signOut() async throws -> AuthState { throw NotScripted() }
    func verifyEmailCode(code: String) async throws -> AuthState { throw NotScripted() }
    func beginProviderSignIn(provider: AuthProvider) throws -> AuthState { throw NotScripted() }
    func abandonProviderSignIn() throws -> AuthState { throw NotScripted() }
    func completeProviderSignIn(idToken: String) async throws -> ProviderSignInOutcome { throw NotScripted() }
}

private struct NotScripted: Error {}

/// A `SecItem*` stand-in that can start with entries already in it, which is
/// what a phone that has been used before looks like.
///
/// Its own type rather than a widening of `RecordingKeychainItems`: the
/// question here is what the **real** `Keychain` asks for on a launch, and
/// keeping the recorder local keeps T147's assertions and T165's from moving
/// together.
final class SeededKeychainItems: KeychainItemStore, @unchecked Sendable {
    private let stored: Mutex<[String: Data]>
    private let reads = Mutex<[(account: String, service: String)]>([])

    init(seed: [String: String] = [:]) {
        stored = Mutex(seed.mapValues { Data($0.utf8) })
    }

    var readAccounts: [(account: String, service: String)] { reads.withLock { $0 } }

    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?) {
        let account = (query[kSecAttrAccount as String] as? String) ?? "<none>"
        reads.withLock {
            $0.append((account, (query[kSecAttrService as String] as? String) ?? "<none>"))
        }
        guard let data = stored.withLock({ $0[account] }) else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data)
    }

    func add(attributes: [String: Any]) -> OSStatus {
        let account = (attributes[kSecAttrAccount as String] as? String) ?? "<none>"
        guard let value = attributes[kSecValueData as String] as? Data else { return errSecParam }
        return stored.withLock { table in
            guard table[account] == nil else { return errSecDuplicateItem }
            table[account] = value
            return errSecSuccess
        }
    }

    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
        let account = (query[kSecAttrAccount as String] as? String) ?? "<none>"
        guard let value = attributes[kSecValueData as String] as? Data else { return errSecParam }
        stored.withLock { $0[account] = value }
        return errSecSuccess
    }

    func delete(query: [String: Any]) -> OSStatus {
        let account = (query[kSecAttrAccount as String] as? String) ?? "<none>"
        return stored.withLock { $0.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess }
    }
}

// MARK: - The suites
//
// One parent, so the three below cannot interleave. `.serialized` orders a
// suite's own tests; it does **not** stop two sibling suites running at once,
// and all three of these assert over the *same* `T165StubURLProtocol` statics.
// Nested under a serialized parent the whole tree runs one test at a time,
// which is what makes "no request was made" a statement about this test rather
// than about the scheduler. It is also how the first run of this file found
// that it was not: the Google exchange's POST arrived inside the account-read
// test and failed it.

@Suite("T165 wiring", .serialized)
struct T165WiringTests {
    @Suite("recovery-phrase wiring", .serialized)
    struct RecoveryPhraseWiringTests {
        /// The whole hop: `CoreAccountKeyMaterial` → `AuthSession.keyMaterial()` →
        /// the core's `HttpClient` → the genuine `URLSessionTransport` → the wire.
        ///
        /// The assertion is the **request**, not the answer. A fake source that
        /// returned a perfectly good salt and verifier would satisfy every
        /// assertion an "it unlocks" test can make and leave this one with an empty
        /// capture list, which is the only shape that separates "wired" from
        /// "wired to something else".
        @Test("the account key material leaves through the real transport, at chapter 02 §2.1.1's route")
        @MainActor
        func keyMaterialLeavesThroughTheRealTransport() async throws {
            T165StubURLProtocol.reset(status: 400, body: #"{"code":"VALIDATION_ERROR","message":"no"}"#)
            let events = CoreEvents()
            let session = try AuthComposition.makeSession(
                environment: .staging,
                device: AuthComposition.device(appVersion: "0.1.0+t165"),
                emitter: events.emitter,
                transportConfiguration: stubbedConfiguration(),
                keychainItems: RecordingKeychainItems()
            )

            // Left to fail: the assertion is about the request leaving the shell,
            // which has already happened by then.
            _ = try? await CoreAccountKeyMaterial(session: session).accountKeyMaterial()

            let first = try #require(T165StubURLProtocol.captured.withLock { $0.first })
            #expect(first.url == "https://sync-staging.memrynote.com/auth/key-verifier")
            #expect(first.method == "GET")
        }

        /// The salt crosses as base64 and the verifier does not cross decoded at
        /// all (chapter 01 §1.1, §1.4.1). Both halves asserted together, because a
        /// source that decoded the verifier as well would still produce a salt that
        /// looks right.
        @Test("the base64 salt is decoded and the verifier is handed on untouched")
        @MainActor
        func materialCrossesInTheShapeTheChapterDefines() async throws {
            let salt = Data((0 ..< 16).map { UInt8($0) })
            let session = ScriptedKeyMaterial(
                answer: KeyMaterial(kdfSalt: salt.base64EncodedString(), keyVerifier: "dmVyaWZpZXI=")
            )

            let material = try await CoreAccountKeyMaterial(session: session).accountKeyMaterial()

            #expect(material.kdfSalt == salt)
            #expect(material.keyVerifier == "dmVyaWZpZXI=")
        }

        /// An answer that arrived and could not be read is a different fact from a
        /// refusal, and it must not reach the user as a phrase that did not match.
        @Test("a salt that is not base64 is a malformed response, not a wrong phrase")
        @MainActor
        func anUnreadableSaltIsNotAWrongPhrase() async throws {
            let session = ScriptedKeyMaterial(
                answer: KeyMaterial(kdfSalt: "not base64 at all!!", keyVerifier: "dmVyaWZpZXI=")
            )

            var raised: (any Error)?
            do {
                _ = try await CoreAccountKeyMaterial(session: session).accountKeyMaterial()
            } catch {
                raised = error
            }

            let mapped = ErrorMapping.userFacing(try #require(raised))
            #expect(mapped.code == "api.malformedResponse")
            // Emphatically not the verifier-mismatch sentence.
            #expect(mapped.code != "recovery.verifierMismatch")
        }
    }

    // MARK: - T148's exchange, and the button

    @Suite("google wiring", .serialized)
    struct GoogleWiringTests {
        /// `GoogleSignIn.init` requires a transport and constructs no
        /// `URLSession`, because `check:architecture` refuses one outside
        /// `Memry/Seams/`. What satisfies it is the **one** seam the core already
        /// drives, not a second session in a second file.
        ///
        /// A working stub closure — the shape every `GoogleSignInTests` case uses —
        /// returns a token response and touches no `URLProtocol`, so it fails this.
        @Test("the google token exchange leaves through the one transport seam")
        @MainActor
        func theTokenExchangeLeavesThroughTheOneTransport() async throws {
            T165StubURLProtocol.reset(status: 200, body: #"{"id_token":"header.payload.signature"}"#)
            let transport = URLSessionTransport(
                emitter: CoreEvents().emitter,
                configuration: stubbedConfiguration()
            )

            var post = URLRequest(url: try #require(URL(string: GoogleSignInConfiguration.tokenEndpoint)))
            post.httpMethod = "POST"
            post.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            post.httpBody = try GoogleSignIn.formEncoded([("grant_type", "authorization_code")])

            let (data, response) = try await GoogleTokenExchange.through(transport)(post)

            let seen = try #require(T165StubURLProtocol.captured.withLock { $0.first })
            #expect(seen.url == GoogleSignInConfiguration.tokenEndpoint)
            #expect(seen.method == "POST")
            #expect(seen.body == "grant_type=authorization_code")
            // A non-2xx must come back as a *response*, so the flow can read the
            // status; and a 2xx must carry the body through unchanged.
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
            #expect(String(bytes: data, encoding: .utf8) == #"{"id_token":"header.payload.signature"}"#)
        }

        /// A refusal is a response and not a thrown transport failure — otherwise
        /// `tokenExchangeRefused(status:)` is unreachable and every Google refusal
        /// reads as "no network".
        @Test("a refused exchange comes back as a status, not as a transport failure")
        @MainActor
        func aRefusalIsAResponse() async throws {
            T165StubURLProtocol.reset(status: 400, body: #"{"error":"invalid_grant"}"#)
            let transport = URLSessionTransport(
                emitter: CoreEvents().emitter,
                configuration: stubbedConfiguration()
            )
            var post = URLRequest(url: try #require(URL(string: GoogleSignInConfiguration.tokenEndpoint)))
            post.httpMethod = "POST"

            let (_, response) = try await GoogleTokenExchange.through(transport)(post)

            #expect((response as? HTTPURLResponse)?.statusCode == 400)
        }

        /// The production button, on the production object graph — **offered,
        /// and deliberately not pressed.**
        ///
        /// It used to be pressed here, and the sentence it produced asserted,
        /// on the premise that no build carries `MemryGoogleClientID`
        /// (spec-defect 117). **That premise died the moment the key landed in
        /// `Info.plist`**: `AuthComposition` then answers a real `GoogleSignIn`
        /// over `SystemWebAuthenticator`, so the press opened an
        /// `ASWebAuthenticationSession` against Google and waited for a person
        /// who is not there. Nothing timed out. The whole `Unit` plan ran every
        /// suite to completion, stopped inside this one test, and `xcodebuild`
        /// wrote **no result bundle at all** — so the plan could not report a
        /// number for anything. A unit test must never drive a seam that waits
        /// on a human, and a test whose premise is "this build is not
        /// configured yet" is a test of ambient build state.
        ///
        /// Everything the press was not needed for is still asserted: the
        /// button exists on the state the user lands on, it is enabled, the
        /// machine has not moved, and this build **is** configured — which is
        /// the fact that made the press dangerous. The sentence for a build
        /// that is not configured is the test below.
        @Test("the production sign-in screen offers Google, and this build is configured for it")
        @MainActor
        func theProductionScreenOffersGoogle() async throws {
            T165StubURLProtocol.reset(status: 400, body: #"{"code":"VALIDATION_ERROR","message":"no"}"#)
            let startup = AuthStartup(
                emitter: CoreEvents().emitter,
                transportConfiguration: stubbedConfiguration(),
                keychainItems: RecordingKeychainItems()
            )
            await startup.begin()
            guard case let .ready(model) = startup.phase else {
                Issue.record("the app root did not reach the core: \(startup.phase)")
                return
            }

            // The button exists, on the state the user actually lands on.
            #expect(model.step.secondary == .signInWithGoogle)
            #expect(model.isEnabled(.signInWithGoogle))
            // Nothing has moved and nothing is being complained about.
            #expect(model.state == .signedOut)
            #expect(model.error == nil)
            // Configured — which is why the button is not pressed here.
            // `GoogleConfigurationTests` owns what the plist must contain.
            #expect(AuthComposition.googleSignIn(transport: URLSessionTransport(
                emitter: CoreEvents().emitter,
                configuration: stubbedConfiguration()
            )) != nil)
        }

        /// The half the press used to carry: a build with **no** client id
        /// offers the same button and says why it cannot use it.
        ///
        /// `google: nil` is exactly what `AuthStartup` holds on such a build —
        /// `AuthComposition.googleSignIn` answers `nil` and no flow is built —
        /// so this runs the screen code a user would meet, with the one
        /// dependency that opens a browser absent rather than substituted. The
        /// assertion is the **literal sentence**: a button wired to the wrong
        /// failure would pass `error != nil`.
        @Test("a build with no client id offers the button and says why it cannot")
        @MainActor
        func anUnconfiguredBuildSaysSo() async throws {
            let session = FakeAuthSession(from: .signedOut)
            let model = SignInViewModel(
                session: session,
                executor: CoreExecutor(label: "t165-google-unconfigured"),
                state: .signedOut,
                google: nil
            )

            await model.run(.signInWithGoogle)

            let error = try #require(model.error)
            #expect(error.title == "Signing in with Google is not available in this build of Memry.")
            #expect(error.guidance == "You can sign in with your email address instead.")
            // Nothing opened and nothing moved: the machine is where it was,
            // and the only thing asked of the core was what state it is in.
            #expect(model.state == .signedOut)
            #expect(session.calls == [.state])
        }
    }

    // MARK: - Spec-defect 121: the launch that reopens a session

    @Suite("cold-launch restore", .serialized)
    struct ColdLaunchRestoreTests {
        /// **The defect, at the production entry point.** `AuthStartup` is what
        /// `RootView` builds; nothing here is a reconstruction of it. The keychain
        /// under the genuine `Keychain` holds a refresh token, as it would on the
        /// second launch of a signed-in phone, and the screen the user lands on is
        /// the unlock screen rather than the sign-in screen.
        ///
        /// Before `restore()` existed this read `.signedOut`, and `unlockModel` was
        /// `nil` twice over — once for the state and once for the absent source.
        @Test("a launch with a refresh token on disk reopens the session and reaches the unlock screen")
        @MainActor
        func aRestoredLaunchReachesTheUnlockScreen() async throws {
            T165StubURLProtocol.reset(status: 400, body: #"{"code":"VALIDATION_ERROR","message":"no"}"#)
            let items = SeededKeychainItems(seed: ["refresh-token": "refresh-from-the-last-run"])
            let startup = AuthStartup(
                emitter: CoreEvents().emitter,
                transportConfiguration: stubbedConfiguration(),
                keychainItems: items
            )

            await startup.begin()

            guard case let .ready(model) = startup.phase else {
                Issue.record("the app root did not reach the core: \(startup.phase)")
                return
            }
            #expect(model.state == .registered)
            // The route T152 shipped dark. Non-nil **and** the real source: a
            // scripted one would satisfy the first half and prove nothing.
            #expect(startup.keyMaterial is CoreAccountKeyMaterial)
            #expect(startup.unlockModel(for: .registered) != nil)
            // Read through the genuine `Keychain`, with data-model §B's query.
            // Swap it for a working in-memory `SecureStore` and this is empty.
            let read = try #require(items.readAccounts.first { $0.account == "refresh-token" })
            #expect(read.service == Keychain.service)
            // And nothing was asked of the network to decide it (spec-defects 108,
            // 109): a launch that awaited a refresh could suspend for an hour and
            // could not be cancelled.
            #expect(T165StubURLProtocol.captured.withLock { $0.isEmpty })
        }

        /// The other arm, and the one that keeps the two distinguishable: an empty
        /// store is `SignedOut`, and it is decided by the **same** read. A restore
        /// that returned `Registered` unconditionally would pass the test above.
        @Test("a first launch with an empty keychain still signs out, through the same read")
        @MainActor
        func aFirstLaunchStaysSignedOut() async throws {
            T165StubURLProtocol.reset(status: 400, body: #"{"code":"VALIDATION_ERROR","message":"no"}"#)
            let items = SeededKeychainItems()
            let startup = AuthStartup(
                emitter: CoreEvents().emitter,
                transportConfiguration: stubbedConfiguration(),
                keychainItems: items
            )

            await startup.begin()

            guard case let .ready(model) = startup.phase else {
                Issue.record("the app root did not reach the core: \(startup.phase)")
                return
            }
            #expect(model.state == .signedOut)
            #expect(model.step.primary == .sendCode)
            #expect(startup.unlockModel(for: model.state) == nil)
            #expect(items.readAccounts.contains { $0.account == "refresh-token" })
        }
    }
}
