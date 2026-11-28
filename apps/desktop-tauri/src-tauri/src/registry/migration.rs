//! The first-launch migration commands (`crate::migration`), which only the `preboot` window
//! may call (`dispatch.rs`).

macro_rules! migration {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::migration::migration_localstorage_applied::<Wry>,
            crate::commands::migration::migration_open_report::<Wry>,
            crate::commands::migration::migration_retry::<Wry>,
            crate::commands::migration::migration_status::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
