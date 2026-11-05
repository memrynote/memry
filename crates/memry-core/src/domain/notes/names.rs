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

/// `applyAliasDelta`: the names in `remove` dropped from `current` by [`name_key`], then `add`
/// appended, the list normalized against `title` ([`normalize_aliases`]).
pub fn apply_alias_delta(
    title: &str,
    current: &[String],
    add: &[String],
    remove: &[String],
) -> Vec<String> {
    let removed: HashSet<String> = remove.iter().filter_map(|name| name_key(name)).collect();
    let kept = current
        .iter()
        .filter(|alias| name_key(alias).is_none_or(|key| !removed.contains(&key)));
    let next: Vec<String> = kept.chain(add).cloned().collect();
    normalize_aliases(title, &next)
}

/// A stored `aliases` column: a JSON string array, NULL for none.
pub fn parse_stored(raw: Option<String>) -> Result<Vec<String>, serde_json::Error> {
    raw.map_or(Ok(Vec::new()), |raw| serde_json::from_str(&raw))
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
    fn an_alias_delta_removes_by_name_key_then_adds_normalized() {
        let names = |list: &[&str]| list.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
        let next = apply_alias_delta(
            "Plan",
            &names(&["AI", "Old  one", "Keep"]),
            &names(&[" A.I. ", "plan", "keep"]),
            &names(&["ai", "old one"]),
        );
        assert_eq!(next, names(&["Keep", "A.I."]));
    }

    #[test]
    fn name_key_collapses_inner_runs_to_one_space() {
        assert_eq!(name_key("a \u{00A0}\t b").as_deref(), Some("a b"));
    }
}
