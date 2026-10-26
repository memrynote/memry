//! Seed half of writing tools in markdown (`applyWritingSeed`): sentinels in a
//! freshly built fragment become anchors and records on the document. See
//! [`super::writing`] for the write half and the position conventions.

use yrs::branch::{Branch, BranchID};
use yrs::{
    Assoc, IndexScope, ReadTxn, StickyIndex, Text as _, Transact as _, TransactionMut,
    XmlFragmentRef,
};

use super::canonical::detach;
use super::writing::{
    RunPosition, TextRun, collect_text_runs, plain_text_of, previous_boundary, text_between,
    width_at,
};
use super::writing_roots::{
    AnchorId, WritingAlternative, WritingAnchor, WritingGhost, WritingOverflowItem, WritingVariant,
    read_writing_alternatives, read_writing_overflow, write_writing_alternatives,
    write_writing_ghosts, write_writing_overflow,
};
use crate::markdown::shared::writing_tools::{
    WritingFrontmatter, WritingFrontmatterAlternative, WritingFrontmatterVersion,
    WritingMarkerKind, WritingSentinelMap,
};

// ----------------------------------------------------------------------------
// Seed: sentinels -> anchors
// ----------------------------------------------------------------------------

struct SeededRange {
    kind: WritingMarkerKind,
    key: String,
    anchor_start: WritingAnchor,
    anchor_end: WritingAnchor,
    shown_text: String,
}

fn anchor_of<T: ReadTxn>(txn: &T, run: &TextRun, index: usize) -> Option<WritingAnchor> {
    let branch = AsRef::<Branch>::as_ref(&run.text);
    let type_id = match branch.id() {
        BranchID::Nested(id) => Some(AnchorId {
            client: id.client.get() as f64,
            clock: f64::from(id.clock),
        }),
        BranchID::Root(_) => None,
    };
    let sticky = StickyIndex::at(txn, branch.into(), index as u32, Assoc::After)?;
    let item = match sticky.scope() {
        IndexScope::Relative(id) => Some(AnchorId {
            client: id.client.get() as f64,
            clock: f64::from(id.clock),
        }),
        _ => None,
    };
    let tname = match branch.id() {
        BranchID::Root(name) => Some(name.to_string()),
        BranchID::Nested(_) => None,
    };
    Some(WritingAnchor {
        type_id,
        tname,
        item,
        assoc: None,
    })
}

/// Read every sentinel out of a freshly built fragment as an anchor and delete
/// it. A range whose sentinels did not both survive the parse is dropped.
///
/// `None` means the anchors could not be built, and nothing has been touched:
/// the sentinels are deleted from the live document only after every anchor
/// exists, so a failure never leaves a body without its ranges.
fn extract_writing_ranges(
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
    sentinels: &WritingSentinelMap,
) -> Option<Vec<SeededRange>> {
    if sentinels.is_empty() {
        return Some(Vec::new());
    }
    struct Found {
        key: String,
        kind: WritingMarkerKind,
        start: Option<RunPosition>,
        end: Option<RunPosition>,
    }
    // Anchors come from a UTF-16 copy (`detach`) with the sentinels gone: the
    // item ids are the live document's, and `StickyIndex::at` counts the same
    // unit as the indices below.
    let BranchID::Root(name) = AsRef::<Branch>::as_ref(fragment).id() else {
        return None;
    };
    let snap_doc = detach(&*txn)?;
    // The fragment first: `get_or_insert_xml_fragment` takes the doc's write
    // lock, which a live read transaction in the same statement would block.
    let snap_fragment = snap_doc.get_or_insert_xml_fragment(&*name);
    if crate::markdown::limits::fragment_too_deep(&snap_doc.transact(), &snap_fragment) {
        return None;
    }
    let mut snap_runs: Vec<TextRun> = Vec::new();
    collect_text_runs(&snap_fragment, &snap_doc.transact(), &mut snap_runs);

    let mut found: Vec<Found> = Vec::new();
    let mut live_runs: Vec<TextRun> = Vec::new();
    collect_text_runs(fragment, &*txn, &mut live_runs);
    let runs = &live_runs;
    if runs.len() != snap_runs.len() {
        return None;
    }
    // (byte index, byte width, UTF-16 index, UTF-16 width) of every sentinel, per run.
    let mut hits: Vec<Vec<(usize, usize, usize, usize)>> = vec![Vec::new(); live_runs.len()];
    for run_number in 0..live_runs.len() {
        let mut removed = 0usize;
        let text = String::from_utf16_lossy(&live_runs[run_number].plain);
        let mut unit = 0usize;
        for (byte, ch) in text.char_indices() {
            let units = ch.len_utf16();
            let Some(marker) = sentinels.get(&ch) else {
                unit += units;
                continue;
            };
            hits[run_number].push((byte, ch.len_utf8(), unit, units));
            let at = match found.iter().position(|f| f.key == marker.key) {
                Some(at) => at,
                None => {
                    found.push(Found {
                        key: marker.key.clone(),
                        kind: marker.kind,
                        start: None,
                        end: None,
                    });
                    found.len() - 1
                }
            };
            let position = RunPosition {
                run: run_number,
                index: unit - removed,
            };
            let slot = if marker.open {
                &mut found[at].start
            } else {
                &mut found[at].end
            };
            slot.get_or_insert(position);
            removed += units;
            unit += units;
        }
    }
    // The copy loses its sentinels first; `runs` then names the text as it will be.
    {
        let mut snap_txn = snap_doc.transact_mut();
        for (run_number, run_hits) in hits.iter().enumerate() {
            for (_, _, unit, units) in run_hits.iter().rev() {
                snap_runs[run_number]
                    .text
                    .remove_range(&mut snap_txn, *unit as u32, *units as u32);
            }
            if !run_hits.is_empty() {
                snap_runs[run_number].plain = plain_text_of(&snap_txn, &snap_runs[run_number].text);
            }
        }
    }
    let snap_txn = snap_doc.transact();
    let runs = &snap_runs;

    let mut ranges = Vec::new();
    for Found {
        key,
        kind,
        start,
        end,
    } in found
    {
        let (Some(start), Some(end)) = (start, end) else {
            continue;
        };
        if start >= end {
            continue;
        }
        // The anchors take the first and the last character, as the editor's do.
        // A range that opens at a run's end starts on the next run's first
        // character; one that closes at a run's start ends on the previous
        // run's last character.
        let mut first = start;
        while first.index >= runs[first.run].plain.len() && first.run < end.run {
            first = RunPosition {
                run: first.run + 1,
                index: 0,
            };
        }
        let mut last_run = end.run;
        let mut last_index = previous_boundary(&runs[last_run].plain, end.index);
        while last_index.is_none() && last_run > first.run {
            last_run -= 1;
            last_index = previous_boundary(&runs[last_run].plain, runs[last_run].plain.len());
        }
        let Some(last_index) = last_index else {
            continue;
        };
        if first.index >= runs[first.run].plain.len() {
            continue;
        }
        let last = RunPosition {
            run: last_run,
            index: last_index,
        };
        if first > last {
            continue;
        }
        let (Some(anchor_start), Some(mut anchor_end)) = (
            anchor_of(&snap_txn, &runs[first.run], first.index),
            anchor_of(&snap_txn, &runs[last.run], last.index),
        ) else {
            return None;
        };
        anchor_end.assoc = Some(-1.0);
        let shown_end = RunPosition {
            run: last.run,
            index: last.index + width_at(&runs[last.run].plain, last.index),
        };
        ranges.push(SeededRange {
            kind,
            key,
            anchor_start,
            anchor_end,
            shown_text: text_between(runs, first, shown_end),
        });
    }
    drop(snap_txn);
    // Every anchor exists: now the live document loses its sentinels.
    for (run_number, run_hits) in hits.iter().enumerate() {
        for (byte, width, _, _) in run_hits.iter().rev() {
            live_runs[run_number]
                .text
                .remove_range(txn, *byte as u32, *width as u32);
        }
    }
    Some(ranges)
}

fn unique_id(preferred: String, taken: &mut Vec<String>) -> String {
    let mut id = preferred.clone();
    let mut n = 1;
    while taken.contains(&id) {
        id = format!("{preferred}-{n}");
        n += 1;
    }
    taken.push(id.clone());
    id
}

/// `applyWritingSeed`: write the doc's writing tools records from a seed:
/// ranges from the sentinels now in `fragment`, versions and overflow from
/// `frontmatter`. `None` means the caller only has the body, and versions and
/// overflow then come from the records already on the doc. Ids and timestamps
/// of records that match ones already there are kept, so re-seeding an
/// unchanged file changes nothing.
pub fn apply_writing_seed(
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
    sentinels: &WritingSentinelMap,
    frontmatter: Option<&WritingFrontmatter>,
) -> bool {
    let existing_alternatives = read_writing_alternatives(&*txn);
    let existing_overflow = read_writing_overflow(&*txn);
    let Some(ranges) = extract_writing_ranges(txn, fragment, sentinels) else {
        return false;
    };

    let mut alternatives: Vec<WritingAlternative> = Vec::new();
    let mut ghosts: Vec<WritingGhost> = Vec::new();
    for range in ranges {
        if range.kind == WritingMarkerKind::Ghost {
            ghosts.push(WritingGhost {
                id: format!("ghost-{}", ghosts.len()),
                anchor_start: range.anchor_start,
                anchor_end: range.anchor_end,
            });
            continue;
        }
        let existing = existing_alternatives.iter().find(|r| r.id == range.key);
        let spec: Option<WritingFrontmatterAlternative> = match frontmatter {
            Some(front) => front
                .alternatives
                .iter()
                .find(|(key, _)| *key == range.key)
                .map(|(_, spec)| spec.clone()),
            None => existing.map(|existing| WritingFrontmatterAlternative {
                original: (existing.original != range.shown_text)
                    .then(|| existing.original.clone()),
                versions: existing
                    .variants
                    .iter()
                    .map(|v| WritingFrontmatterVersion {
                        text: v.text.clone(),
                        ai: (v.source == "ai").then_some(true),
                    })
                    .collect(),
            }),
        };
        let Some(spec) = spec.filter(|s| !s.versions.is_empty()) else {
            continue;
        };
        let original = spec
            .original
            .clone()
            .unwrap_or_else(|| range.shown_text.clone());
        let mut taken: Vec<String> = Vec::new();
        let variants: Vec<WritingVariant> = spec
            .versions
            .iter()
            .enumerate()
            .map(|(index, version)| {
                let matched = existing.and_then(|e| {
                    e.variants
                        .iter()
                        .find(|v| v.text == version.text && !taken.contains(&v.id))
                });
                WritingVariant {
                    id: unique_id(
                        matched.map_or_else(|| format!("v{index}"), |m| m.id.clone()),
                        &mut taken,
                    ),
                    text: version.text.clone(),
                    source: if version.ai == Some(true) {
                        "ai"
                    } else {
                        "user"
                    }
                    .to_owned(),
                    created_at: matched.map_or(0.0, |m| m.created_at),
                }
            })
            .collect();
        let active = if spec.original.is_none() {
            None
        } else {
            variants.iter().find(|v| v.text == range.shown_text)
        };
        alternatives.push(WritingAlternative {
            id: range.key,
            anchor_start: range.anchor_start,
            anchor_end: range.anchor_end,
            original,
            active_variant_id: active.map(|v| v.id.clone()),
            variants,
        });
    }

    write_writing_alternatives(txn, &alternatives);
    write_writing_ghosts(txn, &ghosts);
    let Some(front) = frontmatter else {
        return true;
    };

    // File order is display order (newest first); the timestamps only carry
    // it. The file holds plain text, so an item whose text is unchanged keeps
    // the formatted copy (`html`) the doc already has for it.
    let mut taken: Vec<String> = Vec::new();
    let count = front.overflow.len();
    let overflow: Vec<WritingOverflowItem> = front
        .overflow
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let matched = existing_overflow
                .iter()
                .find(|e| e.text == item.text && !taken.contains(&e.id));
            WritingOverflowItem {
                id: unique_id(
                    matched.map_or_else(|| format!("overflow-{index}"), |m| m.id.clone()),
                    &mut taken,
                ),
                text: item.text.clone(),
                html: matched.and_then(|m| m.html.clone()),
                label: item.label.clone().filter(|l| !l.is_empty()),
                created_at: (count - index) as f64,
            }
        })
        .collect();
    write_writing_overflow(txn, &overflow);
    true
}
