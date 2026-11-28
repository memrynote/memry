//! The billing commands.

macro_rules! billing {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::billing::account_change_plan,
            crate::commands::billing::account_get_billing_status,
            crate::commands::billing::account_open_billing_portal,
            crate::commands::billing::account_preview_plan_change,
            crate::commands::billing::account_refresh_billing_status,
            crate::commands::billing::account_start_checkout,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
