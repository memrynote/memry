//! Writing the sentinels back out: `encodeWritingBody` and the offset shift of
//! `withoutWritingSentinels`. Offsets are UTF-16 code units.

use super::markers::{marker_comment, strip_writing_sentinels};
use super::types::WritingSentinelMap;
use crate::markdown::shared::critic_markup::units::{from_units, to_units};
use crate::markdown::shared::critic_markup::{
    CriticMarkupMark, ParsedCriticMarkup, serialize_critic_markup_units,
};

/// CriticMarkup parsed out of sentinel-bearing text, moved onto the text with
/// the sentinels removed: the offsets every other CriticMarkup reader uses.
/// An offset past the end of the text counts every sentinel.
pub fn without_writing_sentinels(
    parsed: &ParsedCriticMarkup,
    sentinels: &WritingSentinelMap,
) -> ParsedCriticMarkup {
    if sentinels.is_empty() {
        return parsed.clone();
    }
    let mut before: Vec<i64> = vec![0];
    let mut count = 0i64;
    for unit in parsed.plain_text.encode_utf16() {
        if char::from_u32(u32::from(unit)).is_some_and(|ch| sentinels.contains_key(&ch)) {
            count += 1;
        }
        before.push(count);
    }
    let shift = |offset: i64| {
        let at = usize::try_from(offset).unwrap_or(0).min(before.len() - 1);
        offset - before[at]
    };
    ParsedCriticMarkup {
        plain_text: strip_writing_sentinels(&parsed.plain_text, sentinels),
        marks: parsed
            .marks
            .iter()
            .map(|mark| CriticMarkupMark {
                visible_text: strip_writing_sentinels(&mark.visible_text, sentinels),
                start: shift(mark.start),
                end: shift(mark.end),
                original_text: mark
                    .original_text
                    .as_deref()
                    .map(|text| strip_writing_sentinels(text, sentinels)),
                ..mark.clone()
            })
            .collect(),
    }
}

/// The file body for serialized text that carries sentinels: CriticMarkup
/// applied (its offsets count no sentinels), then every sentinel written out
/// as its comment. A writing range that cuts into a CriticMarkup range is
/// widened to cover it, since a comment inside `{++…++}` would end up in the
/// mark's text.
pub fn encode_writing_body(
    text: &str,
    sentinels: &WritingSentinelMap,
    critic_marks: &[CriticMarkupMark],
) -> String {
    let with_critic = if critic_marks.is_empty() {
        to_units(text)
    } else {
        serialize_critic_around_sentinels(text, sentinels, critic_marks)
    };
    if sentinels.is_empty() {
        return from_units(&with_critic);
    }
    let mut out: Vec<u16> = Vec::with_capacity(with_critic.len());
    for unit in with_critic {
        let marker = char::from_u32(u32::from(unit)).and_then(|ch| sentinels.get(&ch));
        match marker {
            Some(marker) => out.extend(marker_comment(marker).encode_utf16()),
            None => out.push(unit),
        }
    }
    from_units(&out)
}

fn serialize_critic_around_sentinels(
    text: &str,
    sentinels: &WritingSentinelMap,
    marks: &[CriticMarkupMark],
) -> Vec<u16> {
    // The text as plain characters, each carrying the sentinels just before
    // it; `before[plain.len()]` holds the trailing ones.
    let mut plain_chars: Vec<char> = Vec::new();
    let mut before: Vec<Vec<char>> = vec![Vec::new()];
    for ch in text.chars() {
        if sentinels.contains_key(&ch) {
            if let Some(last) = before.last_mut() {
                last.push(ch);
            }
        } else {
            plain_chars.push(ch);
            before.push(Vec::new());
        }
    }
    // Characters are code points; offsets are UTF-16 units. Rebuild per unit.
    let mut units: Vec<u16> = Vec::new();
    let mut unit_before: Vec<Vec<char>> = Vec::new();
    for (index, ch) in plain_chars.iter().enumerate() {
        unit_before.push(std::mem::take(&mut before[index]));
        let mut buffer = [0u16; 2];
        let encoded = ch.encode_utf16(&mut buffer);
        for (k, unit) in encoded.iter().enumerate() {
            if k > 0 {
                unit_before.push(Vec::new());
            }
            units.push(*unit);
        }
    }
    unit_before.push(std::mem::take(&mut before[plain_chars.len()]));
    let len = units.len() as i64;

    for mark in marks {
        if mark.end - mark.start < 2 || mark.start < 0 || mark.end > len {
            continue;
        }
        for index in (mark.start + 1)..mark.end {
            let inside = std::mem::take(&mut unit_before[index as usize]);
            for sentinel in inside {
                if sentinels.get(&sentinel).is_some_and(|marker| marker.open) {
                    unit_before[mark.start as usize].push(sentinel);
                } else {
                    unit_before[mark.end as usize].insert(0, sentinel);
                }
            }
        }
    }

    // Positions in the rebuilt text: a plain unit sits after its sentinels.
    let mut rebuilt: Vec<u16> = Vec::new();
    let mut unit_at: Vec<usize> = Vec::new();
    for (index, unit) in units.iter().enumerate() {
        rebuilt.extend(unit_before[index].iter().map(|s| *s as u16));
        unit_at.push(rebuilt.len());
        rebuilt.push(*unit);
    }
    let tail_at = rebuilt.len();
    rebuilt.extend(unit_before[units.len()].iter().map(|s| *s as u16));

    let start_at = |offset: i64| {
        if offset < len {
            unit_at[offset as usize]
        } else {
            tail_at
        }
    };
    let end_at = |offset: i64| {
        if offset == 0 {
            start_at(0)
        } else {
            unit_at[offset as usize - 1] + 1
        }
    };
    let mapped: Vec<CriticMarkupMark> = marks
        .iter()
        .map(|mark| {
            if mark.start < 0 || mark.end > len || mark.end < mark.start {
                return mark.clone();
            }
            let start = start_at(mark.start);
            let end = if mark.end == mark.start {
                start
            } else {
                end_at(mark.end)
            };
            CriticMarkupMark {
                start: start as i64,
                end: end as i64,
                ..mark.clone()
            }
        })
        .collect();
    serialize_critic_markup_units(&rebuilt, &mapped)
}
