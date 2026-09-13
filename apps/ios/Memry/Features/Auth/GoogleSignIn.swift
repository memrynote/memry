import AuthenticationServices
import Foundation
import UIKit

// T148. Google sign-in on iOS, research R14's decision implemented exactly:
// `ASWebAuthenticationSession` with authorization code plus PKCE against the
// iOS OAuth client, the code exchanged by the app as a public client with no
// secret, and **no GoogleSignIn-iOS SDK anywhere in the target** — the vendor
// SDK's privacy manifest declares linked coarse location, device ID and usage
// data for analytics, which would land on the App Store listing of an
// end-to-end-encrypted notes app.
//
// `prefersEphemeralWebBrowserSession = true` is not a preference here. Without
// it the sheet shares Safari's cookie jar, so signing out of Memry leaves a
// Google session that signs the next person straight back in, and the first
// sign-in on a shared phone silently offers the previous owner's account.
//
// ## What this file does NOT do, and cannot
//
// **Nothing here reaches `POST /auth/oauth/google/native`, and nothing can.**
// The task text and R14 both end with "the ID token posted to the existing
// native endpoint", and that half has **no call site in the core**:
//
//   * `AuthSession` exports nine methods and not one of them accepts a
//     provider token. `AuthState.awaitingProviderToken` and
//     `AuthEvent.providerSheetOpened` exist in the generated enums, but no
//     exported method applies that event, so the state is unreachable too.
//   * The shell cannot post it instead. That request needs a `sessionNonce`
//     the core mints and holds privately, and a `devicePublicKey` derived from
//     the signing key inside the core's `SecureStore`; and the `setupToken` it
//     answers with has to reach the core's token store, which is private.
//     There is no arrangement of the exported surface that completes this.
//
// So this file stops at the ID token, which is the shell's whole share of the
// work, and **no Google button is wired into `SignInView`**: a button that
// runs a real Google consent screen and then cannot sign anyone in is worse
// for a production user than no button. Recorded as a spec defect; the call
// site needs a core method — `AuthSession.sign_in_with_provider(provider:,
// idToken:)`, applying `ProviderSheetOpened` then `SetupTokenIssued` — which
// is a `crates/memry-core` change and not in scope for T148.

/// How this app opens the system's web-authentication sheet.
///
/// A seam only so the flow above it is testable: `ASWebAuthenticationSession`
/// needs a window, a user, and a real Google consent screen, none of which
/// exist in CI. **The real implementation is still asserted directly** — see
/// `SystemWebAuthenticator.makeSession`, whose `prefersEphemeralWebBrowserSession`
/// a test reads off a genuine `ASWebAuthenticationSession`.
@MainActor
protocol GoogleWebAuthenticator: Sendable {
    /// - Returns: the callback URL Google redirected to.
    /// - Throws: `ASWebAuthenticationSessionError` as the system reported it,
    ///   so the one place that decides what `canceledLogin` means is the flow.
    func authenticate(url: URL, callbackURLScheme: String) async throws -> URL
}

/// The production authenticator.
@MainActor
final class SystemWebAuthenticator: NSObject, GoogleWebAuthenticator {
    /// Held for the sheet's lifetime. `ASWebAuthenticationSession` is
    /// cancelled when it deallocates, so a session that is only a local in
    /// `authenticate` closes itself the instant the function suspends.
    private var session: ASWebAuthenticationSession?

    /// The one place the session is configured, separated from presenting it
    /// so a test can read the flags off a real instance.
    static func makeSession(
        url: URL,
        callbackURLScheme: String,
        completion: @escaping ASWebAuthenticationSession.CompletionHandler
    ) -> ASWebAuthenticationSession {
        let session = ASWebAuthenticationSession(
            url: url,
            callback: .customScheme(callbackURLScheme),
            completionHandler: completion
        )
        // R14. See the file comment: shared cookies are how one person's
        // Google account signs in as the next person's.
        session.prefersEphemeralWebBrowserSession = true
        return session
    }

    func authenticate(url: URL, callbackURLScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = Self.makeSession(url: url, callbackURLScheme: callbackURLScheme) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else {
                    continuation.resume(throwing: error ?? GoogleSignInFailure.callbackUnreadable)
                }
            }
            session.presentationContextProvider = self
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: GoogleSignInFailure.browserUnavailable)
                return
            }
        }
    }
}

extension SystemWebAuthenticator: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        // An empty anchor makes the system refuse with
        // `presentationContextInvalid`, which surfaces as
        // `browserUnavailable`. That is the honest outcome for an app with no
        // window: better a named refusal than a sheet attached to nothing.
        return window ?? ASPresentationAnchor()
    }
}

/// How one attempt ended.
///
/// Cancellation is a **case**, not an error, which is R14's "treat
/// `canceledLogin` as a non-error" made structural: a caller cannot forget to
/// special-case it, because it never arrives in a `catch`.
enum GoogleSignInOutcome: Sendable, Equatable {
    case idToken(String)
    case cancelled
}

/// The flow: build the request, run the sheet, read the callback, exchange the
/// code.
struct GoogleSignIn: Sendable {
    /// The token exchange's transport, supplied by whoever constructs this.
    ///
    /// **There is no default, and this file constructs no `URLSession`.**
    /// `scripts/check-architecture-boundaries.js` refuses one anywhere outside
    /// `Memry/Seams/`, and it is right to: a second network path is one the
    /// core cannot see, cannot retry and cannot kill-switch. The code exchange
    /// is a real second path, and deciding where it lives — a seam beside
    /// `URLSessionTransport`, or the core driving the exchange through the
    /// `Transport` it already owns — belongs with the task that supplies this
    /// flow's call site, not with this one. Leaving the parameter required is
    /// what stops that decision being made here by accident.
    typealias Exchange = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    let configuration: GoogleSignInConfiguration
    private let authenticator: any GoogleWebAuthenticator
    private let exchange: Exchange

    init(
        configuration: GoogleSignInConfiguration,
        authenticator: any GoogleWebAuthenticator,
        exchange: @escaping Exchange
    ) {
        self.configuration = configuration
        self.authenticator = authenticator
        self.exchange = exchange
    }

    /// - Throws: `GoogleSignInFailure`, and nothing else.
    func signIn() async throws -> GoogleSignInOutcome {
        let request = try GoogleAuthorizationRequest(configuration: configuration)
        let authorizationURL = try request.authorizationURL()
        let callback: URL
        do {
            callback = try await authenticator.authenticate(
                url: authorizationURL,
                callbackURLScheme: configuration.callbackURLScheme
            )
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            Log.auth.info("google sign-in cancelled in the browser", .code("googleSignIn.cancelled"))
            return .cancelled
        } catch let failure as GoogleSignInFailure {
            throw failure
        } catch {
            // Every other `ASWebAuthenticationSessionError` — no presentation
            // context, an invalid one — is Memry failing to present a sheet,
            // not Google refusing anything.
            throw GoogleSignInFailure.browserUnavailable
        }

        let code: String
        do {
            code = try request.authorizationCode(from: callback)
        } catch GoogleSignInFailure.userCancelled {
            // `error=access_denied`: the same decision as closing the sheet,
            // reached through the other door.
            Log.auth.info("google sign-in declined at the consent screen", .code("googleSignIn.cancelled"))
            return .cancelled
        }
        let idToken = try await exchangeCode(code, for: request)
        return .idToken(idToken)
    }

    /// RFC 6749 §4.1.3 plus RFC 7636 §4.5, as a public client: no secret, the
    /// verifier is the proof.
    private func exchangeCode(_ code: String, for request: GoogleAuthorizationRequest) async throws -> String {
        guard let url = URL(string: GoogleSignInConfiguration.tokenEndpoint) else {
            throw GoogleSignInFailure.notConfigured
        }
        var post = URLRequest(url: url)
        post.httpMethod = "POST"
        post.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        post.httpBody = try Self.formEncoded([
            ("client_id", configuration.clientID),
            ("code", code),
            ("code_verifier", request.codeVerifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", configuration.redirectURI)
        ])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await exchange(post)
        } catch {
            throw GoogleSignInFailure.transportFailed
        }

        guard let http = response as? HTTPURLResponse else {
            throw GoogleSignInFailure.tokenExchangeUnreadable
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            // The status is logged and never rendered: a number the user
            // cannot use. It does decide the recourse — see `GoogleSignInCopy`.
            Log.auth.error("google token exchange refused", .status(http.statusCode))
            throw GoogleSignInFailure.tokenExchangeRefused(status: http.statusCode)
        }
        // A 2xx with no `id_token` is not "no token": it is an answer this app
        // could not use, and it must not read as a refusal or as a success.
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let idToken = object["id_token"] as? String,
              !idToken.isEmpty else {
            Log.auth.error("google token exchange carried no id token", .status(http.statusCode))
            throw GoogleSignInFailure.tokenExchangeUnreadable
        }
        return idToken
    }

    /// `application/x-www-form-urlencoded`, encoded by hand.
    ///
    /// `URLComponents.percentEncodedQuery` does **not** encode `+`, and a `+`
    /// in an authorization code or a verifier is read as a space by every form
    /// parser — a sign-in that fails for one user in sixty-four with no
    /// diagnosable cause. The allowed set here is RFC 3986's unreserved
    /// characters and nothing else.
    static func formEncoded(_ fields: [(String, String)]) throws -> Data {
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        var pairs: [String] = []
        for (name, value) in fields {
            guard let encoded = value.addingPercentEncoding(withAllowedCharacters: unreserved) else {
                throw GoogleSignInFailure.tokenExchangeUnreadable
            }
            pairs.append("\(name)=\(encoded)")
        }
        return Data(pairs.joined(separator: "&").utf8)
    }
}
