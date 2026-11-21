//! `plan-append.ts`: what a touched section still receives.

use chrono_tz::Tz;

use super::PlanError;
use super::highlights::{
    EPOCH, LinkedIds, created_ms, image_highlight_url, is_live_highlight, newest_created_at,
    render_highlights,
};
use super::text::{heading_level, parse_ms};
use super::types::{ReadwiseHighlight, SavedImages};
use crate::web::extract::utils::date::iso_string;

pub struct PlanAppendOptions<'a> {
    /// `last` from the section's end marker, or `None` when the note has no readable one.
    pub last: Option<&'a str>,
    /// When the note was created: the floor when `last` is unusable.
    pub note_created: &'a str,
    /// Ids of the highlights whose Readwise link is already in the note.
    pub linked_ids: &'a LinkedIds,
    pub time_zone: Tz,
    pub images: &'a SavedImages,
}

/// `AppendPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendPlan {
    /// List items to add before the end marker, empty when nothing is new.
    pub markdown: String,
    /// The `last` to write into the end marker.
    pub last: String,
}

/// `floors`: `floor` is where candidates start; `held` is where an image highlight starts and
/// what `last` is held to.
fn floors(
    last: Option<&str>,
    note_created: &str,
    present: &[&ReadwiseHighlight],
) -> (Option<f64>, Option<f64>) {
    if let Some(last) = last.and_then(|l| parse_ms(Some(l))) {
        return (Some(last), Some(last));
    }
    let held = parse_ms(Some(note_created));
    let mut floor = held;
    for created in present.iter().filter_map(|h| created_ms(h)) {
        if floor.is_none_or(|f| created + 1.0 > f) {
            floor = Some(created + 1.0);
        }
    }
    (floor, held)
}

/// `planAppend`: the highlights created at or after `last` whose id is not in the note yet.
/// Without a usable `last` the floor is the later of the note's creation and the newest
/// highlight the note links. Heading highlights are never appended.
pub fn plan_append(
    highlights: &[ReadwiseHighlight],
    options: &PlanAppendOptions,
) -> Result<AppendPlan, PlanError> {
    let live: Vec<&ReadwiseHighlight> = highlights
        .iter()
        .filter(|h| is_live_highlight(h) && heading_level(h).is_none())
        .collect();
    let present: Vec<&ReadwiseHighlight> = live
        .iter()
        .copied()
        .filter(|h| options.linked_ids.contains(h.id))
        .collect();
    let (floor, held) = floors(options.last, options.note_created, &present);

    let fresh: Vec<&ReadwiseHighlight> = live
        .iter()
        .copied()
        .filter(|h| {
            if options.linked_ids.contains(h.id) {
                return false;
            }
            let from = if image_highlight_url(h).is_none() {
                floor
            } else {
                held
            };
            match (created_ms(h), from) {
                (Some(created), Some(from)) => created >= from,
                _ => true,
            }
        })
        .collect();

    let rendered = render_highlights(&fresh, options.time_zone, options.images);
    let handled: Vec<&ReadwiseHighlight> = rendered
        .rendered
        .iter()
        .chain(present.iter())
        .copied()
        .collect();
    let floor_iso = match held {
        Some(ms) => iso_string(Some(ms)).map_err(|_| PlanError::InvalidTime)?,
        None => EPOCH.to_string(),
    };
    let last = newest_created_at(&handled, &rendered.missing, &floor_iso)?;
    Ok(AppendPlan {
        markdown: rendered.markdown,
        last,
    })
}
