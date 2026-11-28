//! The iOS beta command.

macro_rules! ios_beta {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::ios_beta::ios_beta_join,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
