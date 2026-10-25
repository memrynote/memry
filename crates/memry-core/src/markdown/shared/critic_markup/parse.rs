//! `parseCriticMarkup` and `serializeCriticMarkup`.

use super::comment::{
    CommentPayload, build_comment_payload, created_at_from_comment_mark_id, fallback_mark_id,
    parse_comment_payload,
};
use super::scan::{Delimited, critic_markup_matches};
use super::types::{CriticMarkupKind, CriticMarkupMark, ParsedCriticMarkup};
use super::units::{from_units, index_of_units, slice_units, to_units, utf16_len};

fn comment_mark(
    start: usize,
    end: usize,
    visible: &str,
    raw_payload: &str,
    payload: CommentPayload,
) -> CriticMarkupMark {
    let id = payload.id.clone().unwrap_or_else(|| {
        fallback_mark_id(CriticMarkupKind::Comment, start, visible, raw_payload)
    });
    let created_at = payload
        .created_at
        .or_else(|| created_at_from_comment_mark_id(payload.id.as_deref()));
    CriticMarkupMark {
        id,
        kind: CriticMarkupKind::Comment,
        visible_text: visible.to_owned(),
        original_text: None,
        body: Some(payload.body),
        metadata: payload.metadata,
        created_at,
        mentions: payload.mentions,
        attachments: payload.attachments,
        format_ranges: payload.format_ranges,
        start: start as i64,
        end: end as i64,
    }
}

fn plain_mark(
    kind: CriticMarkupKind,
    start: usize,
    end: usize,
    visible: &str,
    original: Option<&str>,
    id: String,
) -> CriticMarkupMark {
    CriticMarkupMark {
        id,
        kind,
        visible_text: visible.to_owned(),
        original_text: original.map(str::to_owned),
        body: None,
        metadata: None,
        created_at: None,
        mentions: None,
        attachments: None,
        format_ranges: None,
        start: start as i64,
        end: end as i64,
    }
}

/// Splits `markdown` into plain text and marks. Mark offsets are UTF-16
/// offsets into the plain text.
pub fn parse_critic_markup(markdown: &str) -> ParsedCriticMarkup {
    let mut marks = Vec::new();
    let mut plain = String::new();
    let mut plain_len = 0usize;
    let mut last = 0usize;
    let push = |plain: &mut String, plain_len: &mut usize, text: &str| {
        plain.push_str(text);
        *plain_len += utf16_len(text);
    };

    for found in critic_markup_matches(markdown) {
        push(&mut plain, &mut plain_len, &markdown[last..found.index]);
        let start = plain_len;
        match found.kind {
            Delimited::HighlightedComment { visible, payload } => {
                let parsed = parse_comment_payload(payload);
                push(&mut plain, &mut plain_len, visible);
                marks.push(comment_mark(start, plain_len, visible, payload, parsed));
            }
            Delimited::Addition(visible) => {
                push(&mut plain, &mut plain_len, visible);
                let id = fallback_mark_id(CriticMarkupKind::Addition, start, visible, "");
                marks.push(plain_mark(
                    CriticMarkupKind::Addition,
                    start,
                    plain_len,
                    visible,
                    None,
                    id,
                ));
            }
            Delimited::Deletion(visible) => {
                push(&mut plain, &mut plain_len, visible);
                let id = fallback_mark_id(CriticMarkupKind::Deletion, start, visible, "");
                marks.push(plain_mark(
                    CriticMarkupKind::Deletion,
                    start,
                    plain_len,
                    visible,
                    Some(visible),
                    id,
                ));
            }
            Delimited::Substitution { original, visible } => {
                push(&mut plain, &mut plain_len, visible);
                let id = fallback_mark_id(
                    CriticMarkupKind::Substitution,
                    start,
                    &format!("{original}>{visible}"),
                    "",
                );
                marks.push(plain_mark(
                    CriticMarkupKind::Substitution,
                    start,
                    plain_len,
                    visible,
                    Some(original),
                    id,
                ));
            }
            Delimited::Comment(payload) => {
                let parsed = parse_comment_payload(payload);
                marks.push(comment_mark(start, start, "", payload, parsed));
            }
        }
        last = found.end;
    }
    plain.push_str(&markdown[last..]);
    ParsedCriticMarkup {
        plain_text: plain,
        marks,
    }
}

fn serialize_mark(mark: &CriticMarkupMark, visible: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    let mut put = |text: &str| out.extend(text.encode_utf16());
    match mark.kind {
        CriticMarkupKind::Addition => put("{++"),
        CriticMarkupKind::Deletion => put("{--"),
        CriticMarkupKind::Substitution => {
            put("{~~");
            put(mark.original_text.as_deref().unwrap_or(""));
            put("~>");
        }
        CriticMarkupKind::Comment => put("{=="),
    }
    out.extend_from_slice(visible);
    let mut put = |text: &str| out.extend(text.encode_utf16());
    match mark.kind {
        CriticMarkupKind::Addition => put("++}"),
        CriticMarkupKind::Deletion => put("--}"),
        CriticMarkupKind::Substitution => put("~~}"),
        CriticMarkupKind::Comment => {
            put("==}{>>");
            put(&build_comment_payload(mark));
            put("<<}");
        }
    }
    out
}

fn resolve_mark_range(plain: &[u16], mark: &CriticMarkupMark) -> Option<CriticMarkupMark> {
    let visible = to_units(&mark.visible_text);
    if mark.start >= 0
        && mark.end >= mark.start
        && slice_units(plain, mark.start, mark.end) == visible
    {
        return Some(mark.clone());
    }
    if visible.is_empty() {
        return Some(mark.clone());
    }
    if mark.kind != CriticMarkupKind::Comment {
        return None;
    }
    let next_start = index_of_units(plain, &visible)? as i64;
    Some(CriticMarkupMark {
        start: next_start,
        end: next_start + visible.len() as i64,
        ..mark.clone()
    })
}

/// [`serialize_critic_markup`] over UTF-16 code units, for callers whose text
/// may already hold a cut surrogate pair.
pub fn serialize_critic_markup_units(plain: &[u16], marks: &[CriticMarkupMark]) -> Vec<u16> {
    let mut ranges: Vec<_> = marks
        .iter()
        .filter_map(|mark| resolve_mark_range(plain, mark))
        .collect();
    ranges.sort_by_key(|mark| mark.start);

    let mut result: Vec<u16> = Vec::new();
    let mut cursor: i64 = 0;
    for mark in &ranges {
        if mark.start < cursor {
            continue;
        }
        result.extend_from_slice(slice_units(plain, cursor, mark.start));
        let visible = slice_units(plain, mark.start, mark.end);
        result.extend(serialize_mark(mark, visible));
        cursor = mark.end;
    }
    result.extend_from_slice(slice_units(plain, cursor, plain.len() as i64));
    result
}

/// Writes `marks` back into `plain_text` as CriticMarkup. Mark offsets are
/// UTF-16 offsets; marks whose range no longer holds their text are relocated
/// (comments) or dropped.
pub fn serialize_critic_markup(plain_text: &str, marks: &[CriticMarkupMark]) -> String {
    from_units(&serialize_critic_markup_units(&to_units(plain_text), marks))
}
