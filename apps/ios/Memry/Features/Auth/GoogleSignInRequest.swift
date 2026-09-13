import CryptoKit
import Foundation

// T148, the half with no I/O in it: who this app claims to be, the PKCE pair,
// the authorization URL, and the reading of what comes back on the callback.
//
// **It is separate from the flow on purpose.** Everything here is a pure
// function of its inputs, so every rule research R14 names — the `state` is
// checked, the challenge really is the S256 of the verifier this same request
// will spend, a callback that cannot be read is not a callback with no code —
// is assertable without a browser, a window, or a network.
//
// **Nothing in this file is ever logged.** The authorization code, the
// verifier and the `state` are all credentials for the seconds they live;
// `Log.swift` could not carry them anyway (every message is a `StaticString`),
// and that is the mechanism rather than the reminder.

/// The iOS OAuth client this app authenticates as, plus the two Google
/// endpoints the flow touches.
///
/// **There is no default client id and no fallback to the web client.** The
/// server refuses a token minted for the wrong audience with a `501` and says
/// so loudly (`apps/sync-server/src/routes/auth.ts`); a shell that guessed an
/// id here would turn that into a sign-in that fails for a reason no one can
/// see. Absent configuration throws before the browser opens.
struct GoogleSignInConfiguration: Sendable, Equatable {
    /// `Info.plist` key. Not committed: the id is deployment configuration,
    /// and this app's `Info.plist` does not carry one today.
    static let clientIDKey = "MemryGoogleClientID"
    /// Every Google OAuth client id ends this way. The redirect scheme below
    /// is derived from the id, so an id of another shape would derive a scheme
    /// nothing is registered for — refused rather than derived.
    static let clientIDSuffix = ".apps.googleusercontent.com"
    static let authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    static let tokenEndpoint = "https://oauth2.googleapis.com/token"
    /// `openid` is what makes Google mint an ID token at all; `email` is the
    /// claim `getOrCreateUserByEmail` resolves the account by. Nothing else is
    /// asked for — a profile scope would put a name and a picture on the
    /// consent screen of an app that never reads either.
    static let scope = "openid email"
    /// The path half of the redirect. Google's iOS convention is a single
    /// slash after the scheme; the value only has to match what is registered.
    static let redirectPath = "/oauth2redirect"

    let clientID: String

    /// The reversed client id, which is the redirect scheme an iOS OAuth
    /// client is registered with: `1-a.apps.googleusercontent.com` becomes
    /// `com.googleusercontent.apps.1-a`.
    var callbackURLScheme: String {
        clientID.split(separator: ".").reversed().joined(separator: ".")
    }

    var redirectURI: String {
        "\(callbackURLScheme):\(Self.redirectPath)"
    }

    init(clientID: String) throws {
        let trimmed = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasSuffix(Self.clientIDSuffix),
              trimmed.count > Self.clientIDSuffix.count else {
            throw GoogleSignInFailure.notConfigured
        }
        self.clientID = trimmed
    }

    /// - Parameter bundle: substituted in tests. There is no way to hand
    ///   `Bundle` a missing key otherwise.
    static func fromBundle(_ bundle: Bundle = .main) throws -> GoogleSignInConfiguration {
        guard let value = bundle.object(forInfoDictionaryKey: clientIDKey) as? String else {
            throw GoogleSignInFailure.notConfigured
        }
        return try GoogleSignInConfiguration(clientID: value)
    }
}

/// One authorization attempt: its `state`, its PKCE verifier, and the two
/// operations that bracket the browser.
///
/// **The verifier and the challenge cannot drift apart**, because the
/// challenge is computed from the verifier this value holds rather than stored
/// beside it, and the same value builds the URL and later spends the verifier.
/// There is no shape of this type in which a caller exchanges a code against a
/// verifier that did not produce the challenge it was issued for.
struct GoogleAuthorizationRequest: Sendable {
    let configuration: GoogleSignInConfiguration
    /// Opaque, 256 bits, compared byte-for-byte on the way back.
    let state: String
    /// RFC 7636 §4.1: 43 characters of base64url, which is 32 random bytes.
    let codeVerifier: String

    var codeChallenge: String {
        Self.base64URL(Data(SHA256.hash(data: Data(codeVerifier.utf8))))
    }

    /// - Parameter randomBytes: substituted only to prove the derivation, never
    ///   to weaken it. Production uses the system CSPRNG.
    init(
        configuration: GoogleSignInConfiguration,
        randomBytes: (Int) throws -> Data = GoogleAuthorizationRequest.secureRandomBytes
    ) throws {
        self.configuration = configuration
        state = Self.base64URL(try randomBytes(32))
        codeVerifier = Self.base64URL(try randomBytes(32))
    }

    func authorizationURL() throws -> URL {
        guard var components = URLComponents(string: GoogleSignInConfiguration.authorizationEndpoint) else {
            throw GoogleSignInFailure.notConfigured
        }
        components.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: GoogleSignInConfiguration.scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        guard let url = components.url else { throw GoogleSignInFailure.notConfigured }
        return url
    }

    /// Reads the callback Google sent back to the redirect scheme.
    ///
    /// **A callback that cannot be parsed is never read as a callback with no
    /// code.** `URLComponents.queryItems` is `nil` for a URL with no query at
    /// all, and treating that as "no error and no code" is exactly the
    /// unparseable-as-empty failure the constitution forbids: it would be
    /// reported as a refusal by Google rather than as a callback this app
    /// could not understand.
    ///
    /// **`state` is checked before the `error` parameter is believed.** Google
    /// echoes `state` on a refusal too, so an unsolicited callback claiming
    /// `access_denied` would otherwise be reported to the user as their own
    /// cancellation of a flow they never started.
    func authorizationCode(from callback: URL) throws -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let items = components.queryItems else {
            throw GoogleSignInFailure.callbackUnreadable
        }
        func value(_ name: String) -> String? {
            guard let found = items.last(where: { $0.name == name })?.value, !found.isEmpty else {
                return nil
            }
            return found
        }

        guard let returned = value("state") else { throw GoogleSignInFailure.callbackUnreadable }
        guard Self.constantTimeEquals(returned, state) else { throw GoogleSignInFailure.stateMismatch }

        if let refusal = value("error") {
            // RFC 6749 §4.1.2.1. Google sends this one when the user closes
            // the consent screen, and it is the user's own decision.
            throw refusal == "access_denied"
                ? GoogleSignInFailure.userCancelled
                : GoogleSignInFailure.providerRefused
        }
        guard let code = value("code") else { throw GoogleSignInFailure.callbackUnreadable }
        return code
    }

    // MARK: - Primitives

    static func secureRandomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
            throw GoogleSignInFailure.notConfigured
        }
        return Data(bytes)
    }

    /// RFC 7636's base64url: no padding, `-` and `_` for `+` and `/`. A `+` or
    /// a `/` in a query value survives percent-encoding but not every proxy,
    /// and the padding `=` is what makes a verifier fail to match server-side.
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The `state` check does not need to be constant-time to be correct — it
    /// is a comparison against a value this process minted a moment ago — but
    /// `==` on `String` returns early on the first differing byte, and a
    /// comparison of a secret that returns early is a habit worth not having.
    static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf8)
        let right = Array(rhs.utf8)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for (one, other) in zip(left, right) { difference |= one ^ other }
        return difference == 0
    }
}
