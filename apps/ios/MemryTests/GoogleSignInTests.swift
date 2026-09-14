import AuthenticationServices
import CryptoKit
import Foundation
import Testing

@testable import Memry

// T148. The Google flow, everywhere it can be reached without a browser, a
// window, a Google account, or a network — which is everywhere except the
// sheet itself.
//
// **Why the assertions are shaped the way they are.** "It threw" passes under
// every bug this flow can have: a `state` check deleted, a cancellation
// reported as a refusal, a 400 offered as "try again", a 2xx with no token
// read as a success. So each test below names **which** failure, and the copy
// tests name the **literal sentence**, written out rather than compared
// against `GoogleSignInFailure.userFacing` — comparing two mapped values is
// how a collapsed mapping stays green, because both sides move together.
//
// The PKCE assertion is the one that carries real weight: it takes the
// challenge out of the URL the browser was actually handed, takes the verifier
// out of the body the token exchange actually posted, and checks the second
// hashes to the first. A flow that generated a fresh verifier for the exchange
// would pass every other test in this file.

// MARK: - Fixtures

/// 32 bytes each, drawn in the order `GoogleAuthorizationRequest` draws them:
/// `state` first, then the verifier.
enum PKCEFixture {
    static let stateBytes = Data(100 ..< 132)
    static let verifierBytes = Data(0 ..< 32)
    static let state = "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM"
    static let verifier = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    /// base64url(SHA256(ASCII(verifier))), computed outside Swift.
    static let challenge = "6oZqdX5MOLq_qBJ8vppAnT4fk6AP8UiP9zX8-Rev_9A"

    static let clientID = "1234567890-abcdef.apps.googleusercontent.com"
    static let scheme = "com.googleusercontent.apps.1234567890-abcdef"

    static func configuration() throws -> GoogleSignInConfiguration {
        try GoogleSignInConfiguration(clientID: clientID)
    }

    /// Hands out `stateBytes` then `verifierBytes`, so the two are provably
    /// distinct draws rather than one value used twice.
    static func scriptedRandom() -> (Int) throws -> Data {
        let draws = Draws()
        return { _ in draws.next() }
    }

    final class Draws: @unchecked Sendable {
        private var remaining = [stateBytes, verifierBytes]
        func next() -> Data { remaining.isEmpty ? Data() : remaining.removeFirst() }
    }
}

/// Stands in for the system sheet. Returns a callback, or throws what the
/// system would have thrown.
@MainActor
final class FakeWebAuthenticator: GoogleWebAuthenticator {
    enum Answer {
        case callback((URL) -> URL)
        case failure(any Error)
    }

    private let answer: Answer
    private(set) var presentedURL: URL?
    private(set) var presentedScheme: String?
    private(set) var callCount = 0

    init(_ answer: Answer) {
        self.answer = answer
    }

    func authenticate(url: URL, callbackURLScheme: String) async throws -> URL {
        callCount += 1
        presentedURL = url
        presentedScheme = callbackURLScheme
        switch answer {
        case let .callback(make): return make(url)
        case let .failure(error): throw error
        }
    }

    /// The `state` the flow put in the authorization URL, read back so a
    /// callback can echo the real one.
    static func state(of url: URL) -> String {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        return components?.queryItems?.first { $0.name == "state" }?.value ?? ""
    }
}

/// Records the token-exchange request and replays a scripted answer.
final class RecordingExchange: @unchecked Sendable {
    private(set) var requests: [URLRequest] = []
    private let answer: (URLRequest) throws -> (Data, URLResponse)

    init(status: Int, json: String) {
        answer = { request in
            let url = request.url!
            let head = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(json.utf8), head)
        }
    }

    init(throwing error: any Error) { answer = { _ in throw error } }

    var exchange: GoogleSignIn.Exchange {
        { [self] request in
            requests.append(request)
            return try answer(request)
        }
    }

    /// The posted form, parsed back into fields.
    var postedFields: [String: String] {
        guard let body = requests.last?.httpBody,
              let text = String(data: body, encoding: .utf8) else { return [:] }
        var fields: [String: String] = [:]
        for pair in text.split(separator: "&") {
            let halves = pair.split(separator: "=", maxSplits: 1)
            guard halves.count == 2 else { continue }
            fields[String(halves[0])] = String(halves[1]).removingPercentEncoding
        }
        return fields
    }
}

private let tokenResponse = #"{"access_token":"at","id_token":"header.payload.signature"}"#

// MARK: - Configuration

struct GoogleSignInConfigurationTests {
    @Test("the redirect scheme is the reversed client id, which is what Google registers")
    func reversedClientID() throws {
        let configuration = try PKCEFixture.configuration()
        #expect(configuration.callbackURLScheme == PKCEFixture.scheme)
        #expect(configuration.redirectURI == "\(PKCEFixture.scheme):/oauth2redirect")
        #expect(GoogleSignInConfiguration.scope == "openid email")
    }

    @Test("a client id that is not a Google client id is refused, never used to derive a scheme")
    func refusesForeignClientID() {
        #expect(throws: GoogleSignInFailure.notConfigured) {
            try GoogleSignInConfiguration(clientID: "memry-ios")
        }
        #expect(throws: GoogleSignInFailure.notConfigured) {
            try GoogleSignInConfiguration(clientID: "")
        }
        // The suffix alone is not an id: it would derive the scheme
        // `com.googleusercontent.apps.` and point at nothing.
        #expect(throws: GoogleSignInFailure.notConfigured) {
            try GoogleSignInConfiguration(clientID: ".apps.googleusercontent.com")
        }
    }
}

// MARK: - The request

struct GoogleAuthorizationRequestTests {
    private func request() throws -> GoogleAuthorizationRequest {
        try GoogleAuthorizationRequest(
            configuration: PKCEFixture.configuration(),
            randomBytes: PKCEFixture.scriptedRandom()
        )
    }

    @Test("state and verifier are two separate draws of 32 bytes")
    func separateDraws() throws {
        let made = try request()
        #expect(made.state == PKCEFixture.state)
        #expect(made.codeVerifier == PKCEFixture.verifier)
        #expect(made.state != made.codeVerifier)
        // RFC 7636 §4.1: 43 characters is the minimum, and 32 bytes of
        // base64url is exactly 43.
        #expect(made.codeVerifier.count == 43)
    }

    @Test("the challenge is the S256 of this request's own verifier")
    func challengeIsS256OfVerifier() throws {
        #expect(try request().codeChallenge == PKCEFixture.challenge)
    }

    @Test("base64url carries none of the three characters that break a query or a match")
    func base64URLAlphabet() {
        // 0xFB 0xFF encodes to "+/8=" in standard base64.
        let encoded = GoogleAuthorizationRequest.base64URL(Data([0xFB, 0xFF]))
        #expect(encoded == "-_8")
        #expect(!encoded.contains("+"))
        #expect(!encoded.contains("/"))
        #expect(!encoded.contains("="))
    }

    @Test("the authorization URL is an S256 authorization-code request for this client")
    func authorizationURL() throws {
        let url = try request().authorizationURL()
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value }

        #expect(url.absoluteString.hasPrefix("https://accounts.google.com/o/oauth2/v2/auth?"))
        #expect(query["response_type"] == "code")
        #expect(query["code_challenge_method"] == "S256")
        #expect(query["code_challenge"] == PKCEFixture.challenge)
        #expect(query["state"] == PKCEFixture.state)
        #expect(query["client_id"] == PKCEFixture.clientID)
        #expect(query["redirect_uri"] == "\(PKCEFixture.scheme):/oauth2redirect")
        #expect(query["scope"] == "openid email")
        // The verifier itself never leaves the device in the front channel.
        #expect(!url.absoluteString.contains(PKCEFixture.verifier))
    }

    private func callback(_ query: String) -> URL {
        URL(string: "\(PKCEFixture.scheme):/oauth2redirect\(query)")!
    }

    @Test("a matching callback yields the code")
    func readsCode() throws {
        let made = try request()
        let code = try made.authorizationCode(from: callback("?state=\(PKCEFixture.state)&code=4/abc"))
        #expect(code == "4/abc")
    }

    /// The last query below is the one that matters: Google echoes `state` on
    /// a refusal too, so checking `error` first would report an unsolicited
    /// callback to the user as **their own** cancellation of a flow they never
    /// started. `state` is checked before anything else in the callback is
    /// believed.
    @Test("a callback whose state is not this attempt's is refused, code, error and all")
    func refusesForeignState() throws {
        let made = try request()
        let nearly = String(PKCEFixture.state.dropLast()) + "X"
        let foreign = [
            "?state=someoneelse&code=4/abc",
            "?state=\(nearly)&code=4/abc",
            "?state=someoneelse&error=access_denied"
        ]
        for query in foreign {
            #expect(throws: GoogleSignInFailure.stateMismatch) {
                try made.authorizationCode(from: callback(query))
            }
        }
    }

    /// Every shape of callback this app cannot read. **None of them may be
    /// reported as a refusal or as a cancellation**: "could not tell" looking
    /// like "Google said no" is the failure this whole guard exists to refuse.
    /// The queryless case is the one that matters most — `queryItems` is `nil`
    /// there, and treating `nil` as an empty list is how an unparseable input
    /// reads as an empty one.
    @Test("an unreadable callback is unreadable, never a code-less success")
    func refusesUnreadableCallbacks() throws {
        let made = try request()
        let unreadable = [
            "",
            "?code=4/abc",
            "?state=\(PKCEFixture.state)",
            "?state=\(PKCEFixture.state)&code=",
            "?state=&code=4/abc"
        ]
        for query in unreadable {
            #expect(throws: GoogleSignInFailure.callbackUnreadable) {
                try made.authorizationCode(from: callback(query))
            }
        }
    }

    @Test("access_denied is the user's cancellation; any other error is Google refusing")
    func distinguishesRefusals() throws {
        let made = try request()
        #expect(throws: GoogleSignInFailure.userCancelled) {
            try made.authorizationCode(from: callback("?state=\(PKCEFixture.state)&error=access_denied"))
        }
        #expect(throws: GoogleSignInFailure.providerRefused) {
            try made.authorizationCode(from: callback("?state=\(PKCEFixture.state)&error=invalid_scope"))
        }
    }

    @Test("the constant-time comparison still answers the question it is asked")
    func constantTimeEquality() {
        #expect(GoogleAuthorizationRequest.constantTimeEquals("abc", "abc"))
        #expect(!GoogleAuthorizationRequest.constantTimeEquals("abc", "abd"))
        #expect(!GoogleAuthorizationRequest.constantTimeEquals("abc", "abcd"))
        #expect(!GoogleAuthorizationRequest.constantTimeEquals("", "a"))
        #expect(GoogleAuthorizationRequest.constantTimeEquals("", ""))
    }
}

// MARK: - The flow

@MainActor
struct GoogleSignInFlowTests {
    private func flow(
        _ authenticator: FakeWebAuthenticator,
        _ exchange: RecordingExchange
    ) throws -> GoogleSignIn {
        try GoogleSignIn(
            configuration: PKCEFixture.configuration(),
            authenticator: authenticator,
            exchange: exchange.exchange
        )
    }

    private func echoingAuthenticator() -> FakeWebAuthenticator {
        FakeWebAuthenticator(.callback { url in
            let state = FakeWebAuthenticator.state(of: url)
            return URL(string: "\(PKCEFixture.scheme):/oauth2redirect?state=\(state)&code=4/abc")!
        })
    }

    @Test("a completed consent yields the id token from the exchange")
    func happyPath() async throws {
        let authenticator = echoingAuthenticator()
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        let outcome = try await flow(authenticator, exchange).signIn()
        #expect(outcome == .idToken("header.payload.signature"))
        #expect(authenticator.presentedScheme == PKCEFixture.scheme)
    }

    @Test("the verifier posted is the one whose challenge the browser was handed")
    func pkceIsOneChain() async throws {
        let authenticator = echoingAuthenticator()
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        _ = try await flow(authenticator, exchange).signIn()

        let presented = URLComponents(url: authenticator.presentedURL!, resolvingAgainstBaseURL: false)!
        let challenge = presented.queryItems!.first { $0.name == "code_challenge" }!.value!
        let posted = exchange.postedFields
        let verifier = posted["code_verifier"]!
        let derived = GoogleAuthorizationRequest.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        #expect(derived == challenge)

        #expect(posted["grant_type"] == "authorization_code")
        #expect(posted["code"] == "4/abc")
        #expect(posted["client_id"] == PKCEFixture.clientID)
        #expect(posted["redirect_uri"] == "\(PKCEFixture.scheme):/oauth2redirect")
        // A public client has no secret to send, and sending one would be a
        // secret shipped in an app binary.
        #expect(posted["client_secret"] == nil)
    }

    @Test("two attempts do not reuse one state or one verifier")
    func everyAttemptIsFresh() async throws {
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        let first = echoingAuthenticator()
        _ = try await flow(first, exchange).signIn()
        let second = echoingAuthenticator()
        _ = try await flow(second, exchange).signIn()
        #expect(FakeWebAuthenticator.state(of: first.presentedURL!)
            != FakeWebAuthenticator.state(of: second.presentedURL!))
        #expect(exchange.requests.count == 2)
    }

    @Test("canceledLogin is not an error, and nothing is exchanged")
    func cancellationIsAnOutcome() async throws {
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        let authenticator = FakeWebAuthenticator(
            .failure(ASWebAuthenticationSessionError(.canceledLogin))
        )
        let outcome = try await flow(authenticator, exchange).signIn()
        #expect(outcome == .cancelled)
        #expect(exchange.requests.isEmpty)
    }

    @Test("access_denied at the consent screen is the same cancellation")
    func consentRefusalIsCancellation() async throws {
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        let authenticator = FakeWebAuthenticator(.callback { url in
            URL(string: """
            \(PKCEFixture.scheme):/oauth2redirect?state=\(FakeWebAuthenticator.state(of: url))&error=access_denied
            """)!
        })
        let outcome = try await flow(authenticator, exchange).signIn()
        #expect(outcome == .cancelled)
        #expect(exchange.requests.isEmpty)
    }

    @Test("a sheet the system would not present is Memry's failure, not Google's")
    func presentationFailure() async throws {
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        let authenticator = FakeWebAuthenticator(
            .failure(ASWebAuthenticationSessionError(.presentationContextNotProvided))
        )
        await #expect(throws: GoogleSignInFailure.browserUnavailable) {
            try await flow(authenticator, exchange).signIn()
        }
    }

    @Test("a callback for another attempt is refused and never exchanged")
    func foreignCallbackIsNotExchanged() async throws {
        let exchange = RecordingExchange(status: 200, json: tokenResponse)
        let authenticator = FakeWebAuthenticator(.callback { _ in
            URL(string: "\(PKCEFixture.scheme):/oauth2redirect?state=someoneelse&code=4/abc")!
        })
        await #expect(throws: GoogleSignInFailure.stateMismatch) {
            try await flow(authenticator, exchange).signIn()
        }
        #expect(exchange.requests.isEmpty)
    }

    @Test("a refused exchange carries its status, and a 4xx is not a 5xx")
    func refusedExchange() async throws {
        let authenticator = echoingAuthenticator()
        let refusal = RecordingExchange(status: 400, json: #"{"error":"invalid_grant"}"#)
        await #expect(throws: GoogleSignInFailure.tokenExchangeRefused(status: 400)) {
            try await flow(authenticator, refusal).signIn()
        }
        let unwell = RecordingExchange(status: 503, json: "")
        await #expect(throws: GoogleSignInFailure.tokenExchangeRefused(status: 503)) {
            try await flow(echoingAuthenticator(), unwell).signIn()
        }
    }

    @Test("a 2xx with no usable id token is unreadable, never a success and never a refusal")
    func unusableTokenResponse() async throws {
        for body in [#"{"access_token":"at"}"#, #"{"id_token":""}"#, "not json", #"["id_token"]"#] {
            let exchange = RecordingExchange(status: 200, json: body)
            await #expect(throws: GoogleSignInFailure.tokenExchangeUnreadable) {
                try await flow(echoingAuthenticator(), exchange).signIn()
            }
        }
    }

    @Test("a request that never reached Google is a transport failure")
    func transportFailure() async throws {
        let exchange = RecordingExchange(throwing: URLError(.notConnectedToInternet))
        await #expect(throws: GoogleSignInFailure.transportFailed) {
            try await flow(echoingAuthenticator(), exchange).signIn()
        }
    }

    @Test("the form body encodes the characters a query would not")
    func formEncoding() throws {
        let body = try GoogleSignIn.formEncoded([("code", "a+b/c=d e~f")])
        #expect(String(data: body, encoding: .utf8) == "code=a%2Bb%2Fc%3Dd%20e~f")
    }
}

// MARK: - The real session

@MainActor
struct GoogleWebSessionTests {
    /// The one assertion in this file about production code that a fake
    /// cannot stand in for. Without the ephemeral flag the sheet shares
    /// Safari's cookies, so signing out of Memry leaves a Google session that
    /// signs the next person straight back in.
    @Test("the real session is ephemeral")
    func realSessionIsEphemeral() throws {
        let session = SystemWebAuthenticator.makeSession(
            url: try GoogleAuthorizationRequest(
                configuration: PKCEFixture.configuration(),
                randomBytes: PKCEFixture.scriptedRandom()
            ).authorizationURL(),
            callbackURLScheme: PKCEFixture.scheme
        ) { _, _ in }
        #expect(session.prefersEphemeralWebBrowserSession)
    }
}

// MARK: - Copy

struct GoogleSignInCopyTests {
    static let everyFailure: [GoogleSignInFailure] = [
        .notConfigured, .userCancelled, .callbackUnreadable, .stateMismatch,
        .providerRefused, .browserUnavailable, .transportFailed,
        .tokenExchangeRefused(status: 400), .tokenExchangeRefused(status: 503),
        .tokenExchangeUnreadable
    ]

    @Test("only the user's own cancellation is silent, and it still carries a title and a code")
    func cancellationIsSilentNotUnknown() {
        let mapped = GoogleSignInFailure.userCancelled.userFacing
        #expect(!mapped.isUserVisible)
        #expect(mapped.title == "Google sign-in was cancelled.")
        #expect(mapped.code == "googleSignIn.cancelled")
        for failure in Self.everyFailure where failure != .userCancelled {
            #expect(failure.userFacing.isUserVisible)
        }
    }

    @Test("a permanent refusal is never offered as a transient one")
    func permanentIsNotTransient() {
        let permanent = GoogleSignInFailure.tokenExchangeRefused(status: 400).userFacing
        let transient = GoogleSignInFailure.tokenExchangeRefused(status: 503).userFacing
        #expect(permanent.recourse == .blocked)
        #expect(permanent.title == "Google refused to finish this sign-in.")
        #expect(transient.recourse == .retryLater)
        #expect(transient.title == "Google could not finish the sign-in just now.")
        #expect(permanent.code != transient.code)
        #expect(GoogleSignInFailure.notConfigured.userFacing.recourse == .blocked)
    }

    /// `DESIGN.md` §"Error copy, in detail", four of its bullets at once: a
    /// second sentence on every error the user cannot act on, a distinct
    /// identifying code per variant, and no payload, status or duration in any
    /// sentence — copy reaches screenshots.
    @Test("every failure says what happened and what now, and carries no payload")
    func everySentenceIsWhole() {
        var codes: Set<ErrorCode> = []
        for failure in Self.everyFailure {
            let mapped = failure.userFacing
            #expect(!mapped.title.isEmpty)
            #expect(mapped.title.hasSuffix("."))
            codes.insert(mapped.code)
            if failure != .userCancelled { #expect(mapped.guidance?.isEmpty == false) }
            for forbidden in ["400", "503", "seconds", PKCEFixture.clientID] {
                #expect(!mapped.text.contains(forbidden))
            }
        }
        #expect(codes.count == Self.everyFailure.count)
    }
}
