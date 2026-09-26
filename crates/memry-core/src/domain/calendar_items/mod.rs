//! The calendar on the phone (spec 007): the four synced calendar record
//! types, their merge rules, the range projection desktop's
//! `apps/desktop/src/main/calendar/projection.ts` computes, and the record
//! writes desktop's calendar IPC handlers make.
//!
//! Named `calendar_items` because [`crate::domain::calendar`] is the civil
//! date arithmetic the task rules share.

pub mod merge;

/// `calendar_source` (§5 F1).
pub const SOURCE_TYPE: &str = "calendar_source";
/// `calendar_event`.
pub const EVENT_TYPE: &str = "calendar_event";
/// `calendar_external_event`.
pub const EXTERNAL_TYPE: &str = "calendar_external_event";
/// `calendar_binding`.
pub const BINDING_TYPE: &str = "calendar_binding";

/// Whether an item type is one of the four.
pub fn is_calendar_type(item_type: &str) -> bool {
    matches!(
        item_type,
        SOURCE_TYPE | EVENT_TYPE | EXTERNAL_TYPE | BINDING_TYPE
    )
}

pub mod colors;
pub mod projection;
pub mod projection_sources;
pub mod reads;
pub mod selection;
pub mod zone;

use std::cmp::Ordering;

/// `String.prototype.localeCompare` for the ids and ISO strings the calendar
/// sorts (ICU root collation, reduced to what those strings contain):
/// punctuation before digits before letters, letters compared without case
/// first, and at a full tie lowercase before uppercase.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    fn primary(c: char) -> (u8, u32) {
        if let Some(index) = PUNCTUATION.find(c) {
            (0, index as u32)
        } else if c.is_ascii_digit() {
            (1, c as u32)
        } else if c.is_alphabetic() {
            (2, c.to_lowercase().next().unwrap_or(c) as u32)
        } else {
            (3, c as u32)
        }
    }
    let keys = |s: &str| s.chars().map(primary).collect::<Vec<_>>();
    keys(left).cmp(&keys(right)).then_with(|| {
        let tertiary = |s: &str| s.chars().map(|c| c.is_uppercase()).collect::<Vec<_>>();
        tertiary(left).cmp(&tertiary(right))
    })
}
pub mod write;
