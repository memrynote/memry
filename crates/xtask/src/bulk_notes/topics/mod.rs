//! The content tables of `apps/desktop/scripts/seed-data/bulk-notes.ts`, entry for entry and in
//! the same order: the generator picks by index, so a reordered or edited entry changes every
//! note after it (`tests/bulk_notes_golden.rs` fails).

mod life;
mod work;

use life::{OPS, PERSONAL, READING, TRAVEL, WRITING};
use work::{DESIGN, ENGINEERING, MEETINGS, PRODUCT, RESEARCH};

pub(super) struct Topic {
    pub folder: &'static str,
    pub icon: &'static str,
    pub tags: &'static [&'static str],
    pub subjects: &'static [&'static str],
    pub qualifiers: &'static [&'static str],
    pub systems: &'static [&'static str],
    pub actions: &'static [&'static str],
    pub artifacts: &'static [&'static str],
    pub metrics: &'static [&'static str],
    pub people: &'static [&'static str],
    pub questions: &'static [&'static str],
    /// Fenced code / config blocks that fit this topic.
    pub snippets: &'static [&'static str],
}

pub(super) const TOPICS: &[Topic] = &[
    ENGINEERING,
    RESEARCH,
    MEETINGS,
    PRODUCT,
    DESIGN,
    OPS,
    WRITING,
    READING,
    TRAVEL,
    PERSONAL,
];
