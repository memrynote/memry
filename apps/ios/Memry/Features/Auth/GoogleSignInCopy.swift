import Foundation

// T148. Everything a Google sign-in failure can be, and the single sentence
// each one produces.
//
// **These are not in `ErrorMapping.swift`, for the same reason `SignInErrors`
// is not**: that file maps the fourteen generated core enums, and none of
// these is one — no core call has been made when any of them is decided. They
// reuse `UserFacingError` unchanged, whose shape T147 ratified (spec-defect
// 95), so a view renders a Google failure through exactly the affordances it
// already renders an `AuthError` through.
//
// **`ErrorMapping.userFacing(_ error: any Error)` does not recognise this
// type.** A `GoogleSignInFailure` that reached that funnel would come back as
// `shell.unrecognised` and be logged at `fault`. That is the correct, loud
// outcome for a mistake, and it is why the flow hands callers a typed error
// with `userFacing` on it rather than an `any Error` to guess at. Whether the
// funnel should learn this type is `ErrorMapping`'s owner's call, not this
// task's.
//
// **Voice**: `DESIGN.md` §"Copy and trust" and §"Error copy, in detail". No
// payload of any kind reaches a sentence here — not the account, not the
// provider's own message, not the code. Literals, not a localization
// catalogue: localization is out of scope for phase 4 (spec-defect 98).

/// Every way a Google sign-in can end other than with an ID token.
///
/// Closed, and every case is reachable: there is no "other" variant that would
/// let an unexplained failure read as an explained one.
enum GoogleSignInFailure: Error, Equatable, Sendable {
    /// No iOS OAuth client id in the bundle, or one that is not a Google
    /// client id. Thrown **before** the browser opens.
    case notConfigured
    /// The user closed the consent screen, or the system reported
    /// `ASWebAuthenticationSessionError.canceledLogin`. Not an error.
    case userCancelled
    /// A callback arrived that this app could not read. Never "a callback with
    /// nothing in it".
    case callbackUnreadable
    /// The `state` did not match the one this attempt minted. The callback is
    /// not an answer to this request, so it is refused rather than followed.
    case stateMismatch
    /// Google refused the authorization for a reason that is not the user's
    /// cancellation.
    case providerRefused
    /// The system would not present the web-authentication sheet at all. This
    /// is the app's own fault rather than Google's, and the copy says so
    /// without saying which of Memry's mistakes it was.
    case browserUnavailable
    /// The code could not be sent at all — no network, TLS refused, the
    /// request never reached Google.
    case transportFailed
    /// Google answered the token exchange with a non-2xx. The status decides
    /// whether a retry can ever work.
    case tokenExchangeRefused(status: Int)
    /// A 2xx whose body was not a token response, or one carrying no ID token.
    /// The exchange "succeeded" and produced nothing usable, which is a
    /// different fact from a refusal and must not read as one.
    case tokenExchangeUnreadable
}

extension GoogleSignInFailure {
    /// The one place a Google failure becomes a sentence. Total `switch`, no
    /// `default:`: a case added above must stop this file compiling rather
    /// than inherit its neighbour's copy.
    var userFacing: UserFacingError {
        switch self {
        case .notConfigured:
            copy(
                "googleSignIn.notConfigured",
                "Signing in with Google is not available in this build of Memry.",
                "You can sign in with your email address instead.",
                .blocked
            )
        case .userCancelled:
            // `DESIGN.md`: only the user's own cancellation is silent, and
            // silent means not alerted, never not known — it keeps a title and
            // a code so it still reaches the log.
            copy("googleSignIn.cancelled", "Google sign-in was cancelled.", nil, .retry, visible: false)
        case .callbackUnreadable:
            copy(
                "googleSignIn.callbackUnreadable",
                "Memry could not read Google's answer.",
                "Nothing was signed in. Try again, or sign in with your email address instead.",
                .retry
            )
        case .stateMismatch:
            // Deliberately does not say "someone may be attacking you": the
            // overwhelmingly likelier cause is a stale callback from an
            // abandoned attempt, and copy must be true on every screen that
            // can show it.
            copy(
                "googleSignIn.stateMismatch",
                "That Google sign-in did not belong to this attempt.",
                "Nothing was signed in. Start the sign-in again.",
                .retry
            )
        case .providerRefused:
            copy(
                "googleSignIn.providerRefused",
                "Google would not complete the sign-in.",
                "Nothing was signed in. You can try again, or sign in with your email address instead.",
                .retry
            )
        case .browserUnavailable:
            copy(
                "googleSignIn.browserUnavailable",
                "Memry could not open the Google sign-in window.",
                "Nothing was signed in. Try again, or sign in with your email address instead.",
                .retry
            )
        case .transportFailed:
            copy(
                "googleSignIn.transportFailed",
                "Memry could not reach Google.",
                "Nothing was signed in. Check your connection and try again.",
                .retryLater
            )
        case let .tokenExchangeRefused(status):
            // **A permanent refusal must never be offered as a transient one.**
            // A 400 here is a spent or mismatched authorization code and will
            // be refused identically forever; a 5xx is Google being unwell.
            // The status itself is not rendered — it is a number the user
            // cannot use — but it decides which of the two this is.
            if status >= 500 {
                copy(
                    "googleSignIn.tokenExchangeUnavailable",
                    "Google could not finish the sign-in just now.",
                    "Nothing was signed in. It is worth trying again shortly.",
                    .retryLater
                )
            } else {
                copy(
                    "googleSignIn.tokenExchangeRefused",
                    "Google refused to finish this sign-in.",
                    "Nothing was signed in. Start the sign-in again, or use your email address instead.",
                    .blocked
                )
            }
        case .tokenExchangeUnreadable:
            copy(
                "googleSignIn.tokenExchangeUnreadable",
                "Google's answer was not one Memry could use.",
                "Nothing was signed in. Try again, or sign in with your email address instead.",
                .retry
            )
        }
    }

    private func copy(
        _ code: ErrorCode,
        _ title: String,
        _ guidance: String?,
        _ recourse: UserFacingError.Recourse,
        visible: Bool = true
    ) -> UserFacingError {
        UserFacingError(code: code, title: title, guidance: guidance, recourse: recourse, isUserVisible: visible)
    }
}
