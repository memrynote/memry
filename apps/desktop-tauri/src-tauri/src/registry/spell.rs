//! The spell check commands.

macro_rules! spell {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::spell::spell_check_word,
            crate::commands::spell::spell_add_word,
            crate::commands::spell::spell_add_words,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
