use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization as _;

use crate::domain::tags;

pub const MAX_NOTE_ALIASES: usize = 32;
/// Counted in UTF-16 code units, as desktop's `string.length` counts.
pub const MAX_NOTE_ALIAS_LENGTH: usize = 200;

/// NFC, every run of whitespace collapsed to one space, trimmed, then the tag
/// fold (locale-free: `İ` is `i`, final sigma is `σ`). `None` when nothing is
/// left.
pub fn name_key(raw: &str) -> Option<String> {
    let mut spaced = String::with_capacity(raw.len());
    for c in raw.nfc() {
        if !c.is_whitespace() {
            spaced.push(c);
        } else if !spaced.ends_with(' ') {
            spaced.push(' ');
        }
    }
    let trimmed = spaced.strip_prefix(' ').unwrap_or(&spaced);
    let trimmed = trimmed.strip_suffix(' ').unwrap_or(trimmed);
    (!trimmed.is_empty()).then(|| tags::fold(trimmed))
}

/// The alias list as it is stored: each spelling trimmed, empty and
/// over-long entries dropped, deduped by key with the first spelling kept,
/// an alias equal to the title dropped, at most [`MAX_NOTE_ALIASES`]. Order
/// is kept.
pub fn normalize_aliases(title: &str, aliases: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = name_key(title).into_iter().collect();
    let mut out = Vec::new();
    for raw in aliases {
        let spelling = js_trim(raw);
        let Some(key) = name_key(spelling) else {
            continue;
        };
        if spelling.encode_utf16().count() > MAX_NOTE_ALIAS_LENGTH || !seen.insert(key) {
            continue;
        }
        out.push(spelling.to_owned());
        if out.len() == MAX_NOTE_ALIASES {
            break;
        }
    }
    out
}

/// JavaScript's `String.prototype.trim`, which desktop trims with. It differs
/// from `str::trim` on two characters: it strips U+FEFF and keeps U+0085.
pub(crate) fn js_trim(raw: &str) -> &str {
    raw.trim_matches(|c: char| c != '\u{0085}' && (c.is_whitespace() || c == '\u{FEFF}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_strips_bom_and_keeps_next_line() {
        assert_eq!(js_trim("\u{FEFF} a \u{0085}"), "a \u{0085}");
    }

    #[test]
    fn name_key_collapses_inner_runs_to_one_space() {
        assert_eq!(name_key("a \u{00A0}\t b").as_deref(), Some("a b"));
    }
}
