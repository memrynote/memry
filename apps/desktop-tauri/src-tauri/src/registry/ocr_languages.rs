//! The OCR language commands and event.

macro_rules! ocr_languages {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::ocr_languages::ocr_languages_get_state,
            crate::commands::ocr_languages::ocr_languages_retry,
            crate::commands::ocr_languages::ocr_languages_set,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::OcrLanguagesChangedEvent,
        ] $($chain)*)
    };
}
