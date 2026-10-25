//! Marker decoding: the body's `<!--alt:id-->` and `<!--ghost-->` comments
//! become private-use sentinel characters that ride through the markdown parse.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use super::types::{WritingMarker, WritingMarkerKind, WritingSentinelMap};

const PRIVATE_USE_START: u32 = 0xe000;
const PRIVATE_USE_END: u32 = 0xf8ff;

/// `<!--\s*(\/?)(alt|ghost)(?::([A-Za-z0-9_-]{1,64}))?\s*-->`, with JavaScript's `\s`.
fn marker_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        let ws = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
        Regex::new(&format!(
            r"<!--{ws}*(/?)(alt|ghost)(?::([A-Za-z0-9_-]{{1,64}}))?{ws}*-->"
        ))
        .expect("the writing marker pattern is valid")
    })
}

/// `^[A-Za-z0-9_-]{1,64}$`.
pub fn is_writing_alternative_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A new alternative id from eight random bytes: `byte % 36` in base 36. The
/// caller supplies the randomness (`crypto.getRandomValues` in TypeScript).
pub fn new_writing_alternative_id(mut random_byte: impl FnMut() -> u8) -> String {
    (0..8)
        .map(|_| char::from_digit(u32::from(random_byte() % 36), 36).unwrap_or('0'))
        .collect()
}

/// Hands out private-use characters that do not occur in `taken`, so a
/// sentinel can never be mistaken for a character the author typed.
pub fn create_sentinel_allocator(taken: &str) -> impl FnMut() -> Option<char> + use<> {
    let used: BTreeSet<u32> = taken
        .chars()
        .map(u32::from)
        .filter(|code| (PRIVATE_USE_START..=PRIVATE_USE_END).contains(code))
        .collect();
    let mut next = PRIVATE_USE_START;
    move || {
        while next <= PRIVATE_USE_END && used.contains(&next) {
            next += 1;
        }
        if next > PRIVATE_USE_END {
            return None;
        }
        let ch = char::from_u32(next);
        next += 1;
        ch
    }
}

/// The comment a marker is written as.
pub fn marker_comment(marker: &WritingMarker) -> String {
    let slash = if marker.open { "" } else { "/" };
    match marker.kind {
        WritingMarkerKind::Alt => format!("<!--{slash}alt:{}-->", marker.key),
        WritingMarkerKind::Ghost => format!("<!--{slash}ghost-->"),
    }
}

struct MarkerToken<'a> {
    index: usize,
    length: usize,
    kind: WritingMarkerKind,
    id: Option<&'a str>,
    open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedWritingMarkers {
    pub text: String,
    pub sentinels: WritingSentinelMap,
}

/// The body with every paired marker replaced by a sentinel and every unpaired
/// one removed. Alternatives pair by id (the first open with the first later
/// close of the same id); ghosts pair as nested brackets. Ranges may nest or
/// cross; an alternative id that occurs twice keeps its first range only.
pub fn decode_writing_markers(markdown: &str) -> DecodedWritingMarkers {
    let tokens: Vec<MarkerToken> = marker_pattern()
        .captures_iter(markdown)
        .filter_map(|caps| {
            let whole = caps.get(0)?;
            let kind = match caps.get(2)?.as_str() {
                "alt" => WritingMarkerKind::Alt,
                "ghost" => WritingMarkerKind::Ghost,
                _ => return None,
            };
            Some(MarkerToken {
                index: whole.start(),
                length: whole.len(),
                kind,
                id: caps.get(3).map(|m| m.as_str()),
                open: caps.get(1).map(|m| m.as_str()) != Some("/"),
            })
        })
        .collect();
    if tokens.is_empty() {
        return DecodedWritingMarkers {
            text: markdown.to_owned(),
            sentinels: WritingSentinelMap::new(),
        };
    }

    let mut partner: HashMap<usize, String> = HashMap::new();
    let mut open_alt: HashMap<&str, usize> = HashMap::new();
    let mut paired_alt: HashSet<&str> = HashSet::new();
    let mut ghost_stack: Vec<usize> = Vec::new();
    let mut ghost_count = 0usize;
    for (position, token) in tokens.iter().enumerate() {
        if token.kind == WritingMarkerKind::Ghost {
            if token.open {
                ghost_stack.push(position);
            } else if let Some(opener) = ghost_stack.pop() {
                let key = format!("g{ghost_count}");
                ghost_count += 1;
                partner.insert(opener, key.clone());
                partner.insert(position, key);
            }
            continue;
        }
        let Some(id) = token.id else { continue };
        if paired_alt.contains(id) {
            continue;
        }
        if token.open {
            open_alt.entry(id).or_insert(position);
            continue;
        }
        let Some(opener) = open_alt.remove(id) else {
            continue;
        };
        paired_alt.insert(id);
        partner.insert(opener, id.to_owned());
        partner.insert(position, id.to_owned());
    }

    let mut allocate = create_sentinel_allocator(markdown);
    let mut sentinels = WritingSentinelMap::new();
    let mut sentinel_by_key: HashMap<String, Option<(char, char)>> = HashMap::new();
    let mut text = String::new();
    let mut cursor = 0usize;
    for (position, token) in tokens.iter().enumerate() {
        text.push_str(&markdown[cursor..token.index]);
        if let Some(key) = partner.get(&position) {
            let pair = *sentinel_by_key.entry(key.clone()).or_insert_with(|| {
                let open = allocate()?;
                let close = allocate()?;
                for (ch, is_open) in [(open, true), (close, false)] {
                    sentinels.insert(
                        ch,
                        WritingMarker {
                            kind: token.kind,
                            key: key.clone(),
                            open: is_open,
                        },
                    );
                }
                Some((open, close))
            });
            if let Some((open, close)) = pair {
                text.push(if token.open { open } else { close });
            }
        }
        cursor = token.index + token.length;
    }
    text.push_str(&markdown[cursor..]);
    DecodedWritingMarkers { text, sentinels }
}

/// The text without any sentinel character.
pub fn strip_writing_sentinels(text: &str, sentinels: &WritingSentinelMap) -> String {
    if sentinels.is_empty() {
        return text.to_owned();
    }
    text.chars()
        .filter(|ch| !sentinels.contains_key(ch))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_alternative_id_has_the_written_shape() {
        let mut bytes = [0u8, 35, 36, 71, 255, 1, 2, 3].into_iter();
        let id = new_writing_alternative_id(|| bytes.next().unwrap_or(0));
        assert_eq!(id, "0z0z3123");
        assert!(is_writing_alternative_id(&id));
    }
}
