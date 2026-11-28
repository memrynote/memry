//! The account and sign-in commands and events.

macro_rules! account {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::account::account_get_info,
            crate::commands::account::auth_cancel_oauth,
            crate::commands::account::auth_init_oauth,
            crate::commands::account::auth_refresh_token,
            crate::commands::account::auth_request_otp,
            crate::commands::account::auth_resend_otp,
            crate::commands::account::auth_retry_oauth,
            crate::commands::account::auth_verify_otp,
            crate::commands::account::sync_confirm_recovery_phrase,
            crate::commands::account::sync_get_recovery_phrase,
            crate::commands::account::sync_link_via_recovery,
            crate::commands::account::sync_setup_first_device,
            crate::commands::account::sync_setup_new_account,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::AuthOauthCallbackEvent,
            crate::events::AuthOauthErrorEvent,
            crate::events::AuthOtpDetectedEvent,
            crate::events::AuthSessionExpiredEvent,
            crate::events::AuthSessionRefreshedEvent,
        ] $($chain)*)
    };
}
