import Foundation
import MemryCore

// T147. Everything the sign-in screen says, and the mapping from the core's
// nine auth states to it.
//
// **The view does not compute a state.** `data-model.md` §C.1 draws nine states
// and thirteen edges and the core owns all of them; ``SignInStep`` is a
// *rendering* of one `AuthState`, produced by a total `switch` with no
// `default:`, so a tenth state cannot be invented here and a state added to the
// core stops this file compiling. Every branch below is reachable only because
// an `AuthSession` reported the state that produced it.
//
// **Why the copy lives in a value rather than in the view.** It is the only way
// to assert *which* sentence a specific reported state produced without an
// XCUITest. The alternative — sentences inline in `SignInView` — is what makes
// "the error shows" the strongest assertion anyone can write, and an assertion
// like `errorMessage != nil` passes under almost every bug this screen can
// have.
//
// **Voice**: `DESIGN.md` §"Copy and trust" and §"Error copy, in detail".
// Concise sentence case, a verb in every action label, no hype, no duration the
// user cannot use, and no payload of any kind. **Literals, not a localization
// catalogue**: localization is out of scope for phase 4 (spec-defect 98).

/// One thing the user can ask the core to do from this screen. Each is a
/// labelled edge in §C.1; there is no action here that is not one.
enum SignInAction: Equatable, Sendable {
    /// `SignedOut -> AwaitingOtp`.
    case sendCode
    /// `AwaitingOtp -> SetupPending`, or back to `SignedOut`.
    case verify
    /// Chapter 02 §2.11. Not an edge: the state is unchanged either way.
    case resend
    /// `SetupPending -> Registered`, or `-> SetupExpired`.
    case registerDevice
    /// `SetupExpired -> SetupPending`, or `-> SignedOut`.
    case renewSetup
    /// `SessionExpired -> SignedOut` and `Revoked -> SignedOut`. §C.1 calls the
    /// first "user re-authenticates", and `sign_out` is the only method that
    /// draws it.
    case startOver
    /// T165. `SignedOut -> AwaitingProviderToken`, then the consent sheet,
    /// then `AwaitingProviderToken -> SetupPending`. One action because the
    /// user makes one decision; the three core calls behind it are the view
    /// model's.
    case signInWithGoogle
    /// T165. `AwaitingProviderToken -> SignedOut`, §C.1's "cancelled, expired,
    /// or rejected" edge.
    ///
    /// **Not a Cancel over a core call.** `begin_provider_sign_in` is
    /// synchronous and the consent sheet is the system's own; there is no
    /// suspended Rust future here to interrupt, and there could not be
    /// (spec-defect 108). This is the way out of a state the user is *left*
    /// in, which before T165 had no exported edge and no button at all.
    case abandonProviderSignIn

    var label: String {
        switch self {
        case .sendCode: "Send code"
        case .verify: "Verify"
        case .resend: "Send a new code"
        case .registerDevice: "Finish setup"
        case .renewSetup: "Continue"
        case .startOver: "Sign in again"
        case .signInWithGoogle: "Continue with Google"
        case .abandonProviderSignIn: "Use an email code instead"
        }
    }

    /// Shown beside the spinner while the core is working on this action.
    ///
    /// It exists because the wait can be long and **cannot be cancelled**: the
    /// generated bridge never calls `rust_future_cancel`, so a spinner with no
    /// words is the whole of what a user stuck behind chapter 02 §2.11's rate
    /// limiter would have. It says what is happening and does not promise how
    /// long, because the shell does not know and `DESIGN.md` forbids rendering
    /// a duration the user cannot use.
    var progressLabel: String {
        switch self {
        case .sendCode: "Sending your code"
        case .verify: "Checking your code"
        case .resend: "Sending a new code"
        case .registerDevice: "Setting up this phone"
        case .renewSetup: "Carrying on"
        case .startOver: "Signing out"
        case .signInWithGoogle: "Signing in with Google"
        case .abandonProviderSignIn: "Going back"
        }
    }
}

/// What the screen shows for one core-reported state.
struct SignInStep: Equatable, Sendable {
    /// Which text field belongs to this step, if any. `absent` rather than
    /// `none`, so that assigning one to an optional `@FocusState` cannot be
    /// read as `Optional.none` by either the compiler or a reader.
    enum Field: Hashable, Sendable {
        case email
        case code
        case absent
    }

    let title: String
    /// Always present here: every one of the nine states has something worth
    /// saying about what happens next, including the ones the user cannot act
    /// on (`DESIGN.md`: "An error the user cannot act on still gets a second
    /// sentence").
    let detail: String
    let field: Field
    /// Offered only when no call is in flight, so a step whose work is
    /// automatic shows its button only once that work has stopped or failed.
    let primary: SignInAction?
    let secondary: SignInAction?

    /// The total mapping. No `default:`, on purpose.
    init(_ state: AuthState) {
        switch state {
        case .signedOut:
            self.init(
                title: "Sign in to Memry",
                detail: "Memry emails you a six-digit code. There is no password to remember.",
                // T165. The email code stays primary: it is the path that works
                // in every build, and Google is offered beside it rather than
                // above it.
                field: .email, primary: .sendCode, secondary: .signInWithGoogle
            )
        case let .awaitingOtp(email):
            // The state carries the address precisely so the shell can say this
            // without keeping its own copy of it.
            self.init(
                title: "Enter your code",
                detail: "Memry sent a six-digit code to \(email). Paste it or type it in.",
                field: .code, primary: .verify, secondary: .resend
            )
        // T165: this screen reaches it now. The action is the way **out** —
        // the sheet is the system's and it is already closed by the time this
        // step can be rendered, so leaving it with no button is what stranded
        // a cancelled sign-in before `abandon_provider_sign_in` existed.
        case let .awaitingProviderToken(provider):
            self.init(
                title: "Waiting for \(provider)",
                detail: "Finish signing in in the window that opened, or go back and use an email code.",
                field: .absent, primary: .abandonProviderSignIn, secondary: nil
            )
        case .setupPending:
            self.init(
                title: "Setting up this phone",
                detail: "Memry is registering this phone on your account.",
                field: .absent, primary: .registerDevice, secondary: nil
            )
        case .setupExpired:
            self.init(
                title: "That sign-in took a little too long",
                detail: "Memry can carry on without emailing you another code.",
                field: .absent, primary: .renewSetup, secondary: nil
            )
        case .registered:
            // The next step is unlocking the vault, which is T152's and T155's.
            // Naming it is better than an action this build cannot perform.
            self.init(
                title: "You are signed in",
                detail: "Unlocking your vault on this phone comes next.",
                field: .absent, primary: nil, secondary: nil
            )
        case .refreshing:
            self.init(
                title: "Reconnecting",
                detail: "Memry is renewing this phone's session. Nothing is lost while it does.",
                field: .absent, primary: nil, secondary: nil
            )
        case .sessionExpired:
            self.init(
                title: "Your session has expired",
                detail: "Sign in again to keep using Memry on this phone.",
                field: .absent, primary: .startOver, secondary: nil
            )
        // §C.1: local vault content is removed **before** this is shown. That
        // removal is T159's, and this screen never calls `mark_revoked`, so
        // the copy states what the user must do and claims nothing about what
        // was deleted.
        case .revoked:
            self.init(
                title: "This phone's access was revoked",
                detail: "Someone removed this phone from your account. Sign in again to use Memry here.",
                field: .absent, primary: .startOver, secondary: nil
            )
        }
    }

    private init(
        title: String, detail: String, field: Field,
        primary: SignInAction?, secondary: SignInAction?
    ) {
        self.title = title
        self.detail = detail
        self.field = field
        self.primary = primary
        self.secondary = secondary
    }
}

/// The two failures this screen produces itself.
///
/// They are **not** in `ErrorMapping.swift`: that file maps the fourteen
/// generated core enums, and neither of these is one — no core call has been
/// made when either is decided. They reuse `UserFacingError` unchanged, which
/// is part of what T147 ratifies (spec-defect 95). Whether the two shell-minted
/// values already in `ErrorMapping` (`cancelled`, `unrecognised`) mean these
/// belong there too is that file's owner's call, not this task's.
enum SignInErrors {
    /// The field held something, and it was not six digits. Never rendered as
    /// an empty field or as nothing wrong.
    static let codeNotSixDigits = UserFacingError(
        code: "signIn.codeNotSixDigits",
        title: "A Memry code is six digits.",
        guidance: "Check the email again and copy the six-digit number from it.",
        recourse: .retry,
        isUserVisible: true
    )

    /// Chapter 02 §2.11 caps codes at three per address per ten minutes, and
    /// the **fourth** request is the one that the core's own retry ladder sits
    /// on for as long as the server's `Retry-After` says. The screen stops at
    /// three rather than letting the user walk into that wait.
    ///
    /// No countdown and no "43 seconds": `DESIGN.md` forbids rendering a
    /// duration the user cannot use, and the remaining window is not something
    /// this screen knows anyway.
    static let codeRequestsSpent = UserFacingError(
        code: "signIn.codeRequestsSpent",
        title: "Memry has sent all the codes it can to this address for now.",
        guidance: "Check your inbox, including spam. You can ask for another one later.",
        recourse: .retryLater,
        isUserVisible: true
    )
}
