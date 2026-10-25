//! `dist/elements/footnotes.js`. Stage 2e needs only the section-heading pattern that
//! `adoptExternalFootnotes` tests; `standardizeFootnotes` and its helpers are stage 3.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::utils::js::WS;

/// `FOOTNOTE_SECTION_RE`: `/^(foot\s*notes?|end\s*notes?|notes?|references?)$/i`.
pub static FOOTNOTE_SECTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^(?:(?i-u:foot){WS}*(?i-u:notes?)|(?i-u:end){WS}*(?i-u:notes?)|(?i-u:notes?)|(?i-u:references?))$"
    ))
    .expect("static pattern")
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_headings() {
        for yes in [
            "Footnotes",
            "foot note",
            "End\u{a0}Notes",
            "NOTE",
            "References",
            "reference",
        ] {
            assert!(FOOTNOTE_SECTION_RE.is_match(yes), "{yes}");
        }
        for no in ["Notes and more", "", "foot", "Footnotes\n", "Referencess"] {
            assert!(!FOOTNOTE_SECTION_RE.is_match(no), "{no}");
        }
    }
}
