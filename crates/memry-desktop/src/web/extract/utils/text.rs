//! Text helpers of `dist/utils.js`.

use super::js::{is_js_whitespace, to_lower, trim};

/// `text.replace(/\s+/g, ' ')`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `normalizeText`: smart quotes, dashes, ellipses and whitespace are canonicalized, then the
/// text is trimmed and lowercased, so strings humans read as the same compare equal.
pub fn normalize_text(text: &str) -> String {
    let mapped: String = text
        .chars()
        .map(|c| match c {
            '\u{a0}' => ' ',
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => '\'',
            '\u{2012}'..='\u{2015}' => '-',
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => '"',
            c => c,
        })
        .collect();
    // The ellipsis becomes three characters before whitespace is collapsed.
    let expanded = mapped.replace('\u{2026}', "...");
    to_lower(trim(&collapse_whitespace(&expanded)))
}

/// `countWords`: CJK characters count one each, everything else counts runs of characters
/// above U+0020. Surrogate halves count as non-space, so scanning scalars gives the same answer
/// as scanning UTF-16 units.
pub fn count_words(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut words = 0usize;
    let mut in_word = false;
    for c in text.chars() {
        let code = c as u32;
        if matches!(
            code,
            0x3040..=0x309f | 0x30a0..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af
        ) {
            cjk += 1;
            in_word = false;
        } else if code <= 32 {
            in_word = false;
        } else if !in_word {
            words += 1;
            in_word = true;
        }
    }
    cjk + words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words() {
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("  a  bc\u{a0}d "), 2);
        assert_eq!(count_words("日本語 text"), 4);
        assert_eq!(count_words("a\u{1f600}b c"), 2);
    }

    #[test]
    fn normalizing() {
        assert_eq!(
            normalize_text("  \u{201c}Hi\u{201d}\u{2026} \u{2014} It\u{2019}s  "),
            "\"hi\"... - it's"
        );
    }
}
