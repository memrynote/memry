//! The system font command.

macro_rules! fonts {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::fonts::system_fonts_list,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
