//! The device commands.

macro_rules! devices {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::devices::sync_get_devices,
            crate::commands::devices::sync_remove_device,
            crate::commands::devices::sync_rename_device,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
