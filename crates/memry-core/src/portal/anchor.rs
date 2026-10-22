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

#[cfg(test)]
mod tests {
    use super::*;

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
