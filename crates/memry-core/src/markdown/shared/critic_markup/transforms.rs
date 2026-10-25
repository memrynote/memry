//! Accepting, rejecting and removing CriticMarkup marks (`transforms.ts`).
//! Offsets are UTF-16 code units.

use super::types::{CriticMarkupKind, CriticMarkupMark};
use super::units::{from_units, slice_units, to_units};

#[derive(Debug, Clone, PartialEq)]
pub struct TransformResult {
    pub plain_text: String,
    pub marks: Vec<CriticMarkupMark>,
}

fn unchanged(plain_text: &str, marks: &[CriticMarkupMark]) -> TransformResult {
    TransformResult {
        plain_text: plain_text.to_owned(),
        marks: marks.to_vec(),
    }
}

fn without(marks: &[CriticMarkupMark], id: &str) -> Vec<CriticMarkupMark> {
    marks.iter().filter(|item| item.id != id).cloned().collect()
}

fn shift_marks(marks: Vec<CriticMarkupMark>, change_end: i64, delta: i64) -> Vec<CriticMarkupMark> {
    if delta == 0 {
        return marks;
    }
    marks
        .into_iter()
        .map(|mark| {
            if mark.start < change_end {
                mark
            } else {
                CriticMarkupMark {
                    start: mark.start + delta,
                    end: mark.end + delta,
                    ..mark
                }
            }
        })
        .collect()
}

/// `before + replacement + after` around the mark's range.
fn replace_range(plain_text: &str, mark: &CriticMarkupMark, replacement: &[u16]) -> String {
    let units = to_units(plain_text);
    let mut out = slice_units(&units, 0, mark.start).to_vec();
    out.extend_from_slice(replacement);
    out.extend_from_slice(slice_units(&units, mark.end, units.len() as i64));
    from_units(&out)
}

fn remove_visible_range(
    plain_text: &str,
    marks: &[CriticMarkupMark],
    mark: &CriticMarkupMark,
) -> TransformResult {
    TransformResult {
        plain_text: replace_range(plain_text, mark, &[]),
        marks: shift_marks(without(marks, &mark.id), mark.end, mark.start - mark.end),
    }
}

pub fn accept_critic_mark(
    plain_text: &str,
    marks: &[CriticMarkupMark],
    id: &str,
) -> TransformResult {
    let Some(mark) = marks.iter().find(|item| item.id == id) else {
        return unchanged(plain_text, marks);
    };
    if mark.kind == CriticMarkupKind::Deletion {
        return remove_visible_range(plain_text, marks, mark);
    }
    TransformResult {
        plain_text: plain_text.to_owned(),
        marks: without(marks, id),
    }
}

pub fn reject_critic_mark(
    plain_text: &str,
    marks: &[CriticMarkupMark],
    id: &str,
) -> TransformResult {
    let Some(mark) = marks.iter().find(|item| item.id == id) else {
        return unchanged(plain_text, marks);
    };
    match mark.kind {
        CriticMarkupKind::Addition => remove_visible_range(plain_text, marks, mark),
        CriticMarkupKind::Substitution => {
            let replacement = to_units(mark.original_text.as_deref().unwrap_or(""));
            let delta = replacement.len() as i64 - (mark.end - mark.start);
            TransformResult {
                plain_text: replace_range(plain_text, mark, &replacement),
                marks: shift_marks(without(marks, id), mark.end, delta),
            }
        }
        _ => TransformResult {
            plain_text: plain_text.to_owned(),
            marks: without(marks, id),
        },
    }
}

pub fn resolve_critic_mark(
    plain_text: &str,
    marks: &[CriticMarkupMark],
    id: &str,
) -> TransformResult {
    TransformResult {
        plain_text: plain_text.to_owned(),
        marks: without(marks, id),
    }
}

pub fn delete_critic_mark(
    plain_text: &str,
    marks: &[CriticMarkupMark],
    id: &str,
) -> TransformResult {
    resolve_critic_mark(plain_text, marks, id)
}
