//! `PARTIAL_SELECTORS_REGEX` and `PARTIAL_SELECTORS_ANCHORED_REGEX` of `dist/constants.js`:
//! `new RegExp(PARTIAL_SELECTORS.join('|'), 'i')`, plain and anchored as `^(?:...)$`.
//!
//! JS `i` without `u` folds ASCII letters only (a non-ASCII character never maps into ASCII), so
//! each alternative is compiled with `(?i-u)`; Rust's Unicode folding would also equate `s` with
//! U+017F and `k` with U+212A. The table holds literals plus six sources that use regex syntax;
//! those are translated by name below and a test fails if the table gains one that is not.

use std::sync::LazyLock;

use regex::Regex;

use super::patterns::PARTIAL_SELECTORS;

/// An alternative that JS expresses with a lookbehind. Matches `literal` not preceded by
/// `forbidden_before` (checked on the ASCII-lowercased text, which keeps byte offsets).
struct Lookbehind {
    source: &'static str,
    literal: &'static str,
    preceded_by: fn(&[u8]) -> bool,
}

const LOOKBEHINDS: [Lookbehind; 2] = [
    Lookbehind {
        source: "(?<!main-)access-wall",
        literal: "access-wall",
        preceded_by: |before| before.ends_with(b"main-"),
    },
    Lookbehind {
        source: "(?<!h[1-6]-)related",
        literal: "related",
        preceded_by: |before| matches!(before, [.., b'h', b'1'..=b'6', b'-']),
    },
];

/// True when the JS source has no regex syntax, so it matches itself.
fn is_literal(source: &str) -> bool {
    !source.contains([
        '\\', '(', ')', '[', ']', '{', '}', '?', '*', '+', '|', '^', '$', '.',
    ])
}

/// Rust source of one alternative, or `None` when it is handled as a lookbehind.
fn translate(source: &str, anchored: bool) -> Option<String> {
    if let Some(lookbehind) = LOOKBEHINDS.iter().find(|l| l.source == source) {
        // At offset 0 (the anchored form) nothing precedes the literal, so the lookbehind holds.
        return anchored.then(|| format!("(?i-u:{})", regex::escape(lookbehind.literal)));
    }
    Some(match source {
        r"-comment\b" => r"(?i-u:-comment\b)".to_string(),
        // JS `.` excludes the four line terminators; Rust's excludes only `\n`.
        "cookie.law" => "(?i-u:cookie)[^\\n\\r\\x{2028}\\x{2029}](?i-u:law)".to_string(),
        r"hero[_\-a-z]" => r"(?i-u:hero[_\-a-z])".to_string(),
        r"\bnocontent\b" => r"(?i-u:\bnocontent\b)".to_string(),
        literal => {
            debug_assert!(
                is_literal(literal),
                "PARTIAL_SELECTORS entry needs a translation: {literal}"
            );
            format!("(?i-u:{})", regex::escape(literal))
        }
    })
}

fn compile(anchored: bool) -> Regex {
    let alternatives: Vec<String> = PARTIAL_SELECTORS
        .iter()
        .filter_map(|source| translate(source, anchored))
        .collect();
    let joined = alternatives.join("|");
    let pattern = if anchored {
        format!("^(?:{joined})$")
    } else {
        joined
    };
    Regex::new(&pattern).expect("PARTIAL_SELECTORS compile")
}

static PARTIAL: LazyLock<Regex> = LazyLock::new(|| compile(false));
static ANCHORED: LazyLock<Regex> = LazyLock::new(|| compile(true));

/// `PARTIAL_SELECTORS_REGEX.test(value)`.
pub fn partial_selectors_match(value: &str) -> bool {
    if PARTIAL.is_match(value) {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    LOOKBEHINDS.iter().any(|l| {
        lower
            .match_indices(l.literal)
            .any(|(at, _)| !(l.preceded_by)(&lower.as_bytes()[..at]))
    })
}

/// `PARTIAL_SELECTORS_ANCHORED_REGEX.test(value)`: the whole value is one token.
pub fn partial_selectors_anchored_match(value: &str) -> bool {
    ANCHORED.is_match(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_regex_source_has_a_translation() {
        for source in PARTIAL_SELECTORS {
            if !is_literal(source) {
                assert!(
                    LOOKBEHINDS.iter().any(|l| l.source == *source)
                        || matches!(
                            *source,
                            r"-comment\b" | "cookie.law" | r"hero[_\-a-z]" | r"\bnocontent\b"
                        ),
                    "untranslated regex source {source}"
                );
            }
        }
    }

    #[test]
    fn lookbehinds_check_every_occurrence() {
        assert!(!partial_selectors_match("main-access-wall"));
        assert!(partial_selectors_match("main-access-wall access-wall"));
        assert!(partial_selectors_match("x-access-wall"));
        assert!(!partial_selectors_match("h2-related"));
        assert!(partial_selectors_match("h7-related"));
        assert!(partial_selectors_match("h2-related RELATED"));
    }

    #[test]
    fn case_folding_is_ascii_only() {
        assert!(partial_selectors_match("SIDEBAR-CONTENT"));
        // U+017F (long s) and U+212A (Kelvin sign) fold to ASCII in Rust but not in JS.
        assert!(!partial_selectors_match("\u{17f}ponsor"));
        assert!(!partial_selectors_match("tic\u{212a}er-x"));
        assert!(partial_selectors_match("cookie\u{2022}law"));
        assert!(!partial_selectors_match("cookie\nlaw"));
    }

    #[test]
    fn anchored_form_needs_the_whole_value() {
        assert!(partial_selectors_anchored_match("Sponsor"));
        assert!(!partial_selectors_anchored_match("sponsors-x"));
        assert!(partial_selectors_anchored_match("related"));
    }
}
