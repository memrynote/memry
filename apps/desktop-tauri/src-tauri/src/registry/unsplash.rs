//! The Unsplash search command.

macro_rules! unsplash {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::unsplash::unsplash_search,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
