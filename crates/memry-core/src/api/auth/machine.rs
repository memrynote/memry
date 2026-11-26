use super::{AuthEvent, AuthState};

/// The transition table. `None` is "not an edge", which the caller reports
/// rather than swallows.
pub fn transition(state: &AuthState, event: &AuthEvent) -> Option<AuthState> {
    use AuthEvent as E;
    use AuthState as S;
    Some(match (state, event) {
        (S::SignedOut, E::OtpRequested { email }) => S::AwaitingOtp {
            email: email.clone(),
        },
        (S::SignedOut, E::ProviderSheetOpened { provider }) => S::AwaitingProviderToken {
            provider: provider.clone(),
        },
        // spec-defect 121. The third and last edge out of `SignedOut`, and the
        // only one that is not a user action: the other two need an OTP or a
        // consent sheet, so before this a registered user who quit the app was
        // shown the sign-in screen with a working session in their keychain.
        //
        // It lands in `Registered` rather than in a tenth "maybe signed in"
        // state because `Registered` is a *claim* the server adjudicates, not
        // an assertion that the token is good: `SessionExpired` and `Revoked`
        // are both edges **out of** `Registered`, so restoring here is what
        // makes them reachable at all. Restoring into `SignedOut` — today's
        // behaviour — is what collapses the three.
        (S::SignedOut, E::SessionRestored) => S::Registered,

        (S::AwaitingOtp { .. } | S::AwaitingProviderToken { .. }, E::SetupTokenIssued) => {
            S::SetupPending
        }
        (S::AwaitingOtp { .. } | S::AwaitingProviderToken { .. }, E::SignInFailed) => S::SignedOut,

        (S::SetupPending, E::DeviceRegistered) => S::Registered,
        (S::SetupPending, E::SetupTokenExpired) => S::SetupExpired,

        (S::SetupExpired, E::SetupTokenRenewed) => S::SetupPending,
        (S::SetupExpired, E::SetupNotRenewable) => S::SignedOut,

        (S::Registered, E::RefreshStarted) => S::Refreshing,
        (S::Registered, E::RefreshRefused) => S::SessionExpired,
        (S::Registered, E::DeviceRevoked) => S::Revoked,
        (S::Registered, E::SignedOutByUser) => S::SignedOut,

        (S::Refreshing, E::RefreshSucceeded) => S::Registered,
        (S::Refreshing, E::RefreshRefused) => S::SessionExpired,

        (S::SessionExpired, E::RefreshSucceeded) => S::Registered,
        (S::SessionExpired, E::SignedOutByUser) => S::SignedOut,

        (S::Revoked, E::SignedOutByUser) => S::SignedOut,

        _ => return None,
    })
}

pub(super) fn state_name(state: &AuthState) -> String {
    match state {
        AuthState::SignedOut => "SignedOut",
        AuthState::AwaitingOtp { .. } => "AwaitingOtp",
        AuthState::AwaitingProviderToken { .. } => "AwaitingProviderToken",
        AuthState::SetupPending => "SetupPending",
        AuthState::SetupExpired => "SetupExpired",
        AuthState::Registered => "Registered",
        AuthState::Refreshing => "Refreshing",
        AuthState::SessionExpired => "SessionExpired",
        AuthState::Revoked => "Revoked",
    }
    .to_string()
}
