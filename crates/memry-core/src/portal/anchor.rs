//! The ` ^anchor` suffix a portal addresses a block by (§12.6.3).
//!
//! Grammar `[a-z0-9][a-z0-9-]{3,31}`, at the end of the block's text, preceded
//! by the start of the text or whitespace; trailing whitespace is allowed.

fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Whether `value` is a whole, valid anchor.
pub fn is_anchor(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let body_ok = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    (4..=32).contains(&value.chars().count())
        && body_ok(first)
        && chars.all(|c| body_ok(c) || c == '-')
}

/// The anchor a block's text ends with. A caret inside a word is not one.
pub fn extract_anchor(text: &str) -> Option<String> {
    let trimmed = text.trim_end_matches(is_space);
    let token = trimmed
        .rsplit(is_space)
        .next()
        .expect("rsplit yields at least one item");
    let anchor = token.strip_prefix('^')?;
    is_anchor(anchor).then(|| anchor.to_string())
}

/// The text without its trailing anchor and the whitespace before it (`stripAnchor`).
pub fn strip_anchor(text: &str) -> &str {
    if extract_anchor(text).is_none() {
        return text;
    }
    let trimmed = text.trim_end_matches(is_space);
    match trimmed.char_indices().rev().find(|(_, c)| is_space(*c)) {
        Some((at, _)) => &text[..at],
        None => "",
    }
}

const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const ANCHOR_ATTEMPTS: usize = 20;

/// Six random base-36 characters (`makeAnchor`).
fn make_anchor() -> String {
    crate::crypto::sodium::random_bytes(6)
        .into_iter()
        .map(|byte| char::from(ALPHABET[usize::from(byte) % ALPHABET.len()]))
        .collect()
}

/// A fresh anchor no block of the note carries. `None` only when 20 draws all collided, which
/// means the random source is broken: six characters leave two billion anchors.
pub(crate) fn fresh_anchor(taken: &std::collections::HashSet<String>) -> Option<String> {
    (0..ANCHOR_ATTEMPTS)
        .map(|_| make_anchor())
        .find(|anchor| !taken.contains(anchor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_anchor_and_the_space_before_it() {
        assert_eq!(strip_anchor("Parent ^par1"), "Parent");
        assert_eq!(strip_anchor("a  b ^ab-12  "), "a  b");
        assert_eq!(strip_anchor("^par1"), "");
        assert_eq!(strip_anchor("word^par1"), "word^par1");
        assert_eq!(strip_anchor("plain"), "plain");
    }

    #[test]
    fn a_made_anchor_is_an_anchor() {
        let anchor = fresh_anchor(&Default::default()).expect("anchor");
        assert_eq!(anchor.len(), 6);
        assert!(is_anchor(&anchor), "{anchor}");
    }

    #[test]
    fn finds_a_trailing_anchor() {
        assert_eq!(extract_anchor("Parent ^par1").as_deref(), Some("par1"));
        assert_eq!(extract_anchor("^ab-12  \n").as_deref(), Some("ab-12"));
    }

    #[test]
    fn rejects_what_the_grammar_rejects() {
        assert_eq!(extract_anchor("word^par1"), None);
        assert_eq!(extract_anchor("x ^abc"), None, "three characters");
        assert_eq!(extract_anchor("x ^-abc1"), None, "leading dash");
        assert_eq!(extract_anchor("x ^ABCD"), None, "uppercase");
        assert_eq!(extract_anchor("x ^par1 tail"), None, "not at the end");
        assert_eq!(
            extract_anchor("x ^a1234567890123456789012345678901234"),
            None
        );
        assert!(is_anchor(&"a".repeat(32)));
        assert!(!is_anchor(&"a".repeat(33)));
    }
}
