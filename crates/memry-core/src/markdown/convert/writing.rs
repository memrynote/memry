//! The Yjs half of writing tools in markdown (`writing-markdown.ts`; the text
//! half and the format are `shared::writing_tools`).
//!
//! The Y.Doc keeps alternatives and ghosts anchored with relative positions,
//! so a range follows edits while the note is open. The file keeps them as
//! comment markers. Both directions go through sentinel characters in the
//! fragment's text, because only the fragment knows which markdown character a
//! Yjs position became:
//!
//! - write: resolve each record's anchors on a detached snapshot, insert a
//!   sentinel at each end, serialize, then turn sentinels into comments.
//! - seed: markers become sentinels before the parse, so they land in the
//!   fragment's text; each one is read off as an anchor and deleted.
//!
//! Positions are UTF-16 code units, as in Yjs. The write side works on a
//! detached UTF-16 copy of the document (`canonical::detach`); the seed side
//! removes sentinels from the live document by byte offset (the registry's
//! offset kind) and takes its anchors from such a copy.

use yrs::branch::Branch;
use yrs::types::text::YChange;
use yrs::{
    Assoc, ClientID, ID, IndexScope, Out, ReadTxn, StickyIndex, Text as _, Transact as _,
    XmlFragment, XmlOut, XmlTextRef,
};

use super::writing_roots::{
    AnchorId, WritingAlternative, WritingAnchor, WritingGhost, WritingOverflowItem,
};
use crate::markdown::shared::writing_tools::{
    WritingFrontmatter, WritingFrontmatterAlternative, WritingFrontmatterOverflowItem,
    WritingFrontmatterVersion, WritingMarker, WritingMarkerKind, WritingSentinelMap,
    create_sentinel_allocator, is_writing_alternative_id, js_entry_order,
};

pub(super) struct TextRun {
    pub(super) text: XmlTextRef,
    /// The run's text in UTF-16 code units.
    pub(super) plain: Vec<u16>,
}

/// Inline embeds count as one character, as they do in Yjs indices.
pub(super) fn plain_text_of<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> Vec<u16> {
    text.diff(txn, YChange::identity)
        .into_iter()
        .flat_map(|chunk| match chunk.insert {
            Out::Any(yrs::Any::String(s)) => s.encode_utf16().collect::<Vec<u16>>(),
            _ => vec![0xfffc],
        })
        .collect()
}

/// Every text run of the fragment, in document order.
pub(super) fn collect_text_runs<F: XmlFragment, T: ReadTxn>(
    parent: &F,
    txn: &T,
    runs: &mut Vec<TextRun>,
) {
    for child in parent.children(txn) {
        match child {
            XmlOut::Text(text) => {
                let plain = plain_text_of(txn, &text);
                runs.push(TextRun { text, plain });
            }
            XmlOut::Element(element) => collect_text_runs(&element, txn, runs),
            XmlOut::Fragment(_) => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct RunPosition {
    pub(super) run: usize,
    pub(super) index: usize,
}

pub(super) fn text_between(runs: &[TextRun], start: RunPosition, end: RunPosition) -> String {
    let slice = |run: usize, from: usize, to: usize| -> &[u16] {
        let plain = &runs[run].plain;
        let to = to.min(plain.len());
        plain.get(from.min(to)..to).unwrap_or(&[])
    };
    let mut units: Vec<u16> = Vec::new();
    if start.run == end.run {
        units.extend_from_slice(slice(start.run, start.index, end.index));
    } else {
        units.extend_from_slice(slice(start.run, start.index, usize::MAX));
        for run in &runs[start.run + 1..end.run] {
            units.extend_from_slice(&run.plain);
        }
        units.extend_from_slice(slice(end.run, 0, end.index));
    }
    String::from_utf16_lossy(&units)
}

/// The code unit before `index`. The TypeScript takes `end - 1` in UTF-16 units
/// without regard to surrogate pairs, so an anchor can sit on a pair's second
/// half; the anchors must match, and the write side resolves them to the
/// position after it.
pub(super) fn previous_boundary(plain: &[u16], index: usize) -> Option<usize> {
    (index > 0 && index <= plain.len()).then(|| index - 1)
}

pub(super) fn width_at(plain: &[u16], index: usize) -> usize {
    let _ = (plain, index);
    1
}

// ----------------------------------------------------------------------------
// Write: anchors -> sentinels
// ----------------------------------------------------------------------------

/// What [`insert_writing_sentinels`] produced.
pub struct EncodedWritingRanges {
    pub sentinels: WritingSentinelMap,
    /// Alternatives that resolved to a range, with the text the body shows for each.
    pub alternatives: Vec<(WritingAlternative, String)>,
}

struct ResolvedRange {
    kind: WritingMarkerKind,
    key: String,
    start: RunPosition,
    end: RunPosition,
}

fn sticky_of(anchor: &WritingAnchor) -> Option<StickyIndex> {
    let id = |a: AnchorId| ID::new(ClientID::new(a.client as u64), a.clock as u32);
    let scope = if let Some(item) = anchor.item {
        IndexScope::Relative(id(item))
    } else if let Some(name) = &anchor.tname {
        IndexScope::Root(name.as_str().into())
    } else {
        IndexScope::Nested(id(anchor.type_id?))
    };
    let assoc = if anchor.assoc.unwrap_or(0.0) >= 0.0 {
        Assoc::After
    } else {
        Assoc::Before
    };
    Some(StickyIndex::new(scope, assoc))
}

fn resolve_position<T: ReadTxn>(
    txn: &T,
    runs: &[TextRun],
    anchor: &WritingAnchor,
) -> Option<RunPosition> {
    let offset = sticky_of(anchor)?.get_offset(txn)?;
    let branch: &Branch = &offset.branch;
    let run = runs
        .iter()
        .position(|r| std::ptr::eq(AsRef::<Branch>::as_ref(&r.text), branch))?;
    // The snapshot counts UTF-16 units (see `detach`).
    Some(RunPosition {
        run,
        index: offset.index as usize,
    })
}

fn resolve_range<T: ReadTxn>(
    txn: &T,
    runs: &[TextRun],
    start: &WritingAnchor,
    end: &WritingAnchor,
) -> Option<(RunPosition, RunPosition)> {
    let (start, end) = (
        resolve_position(txn, runs, start)?,
        resolve_position(txn, runs, end)?,
    );
    (start < end).then_some((start, end))
}

/// Insert a sentinel at both ends of every alternative and ghost that still
/// resolves on `snapshot`, which must be a throwaway copy: the inserts are real
/// edits. Records whose range no longer resolves (its text was deleted) are
/// left out, and so leave the file.
///
/// Crate-private: positions are UTF-16 units, so `snapshot` must be a
/// `canonical::detach` copy (the registry's own documents count bytes).
pub(crate) fn insert_writing_sentinels(
    snapshot: &yrs::Doc,
    fragment: &str,
    alternatives: &[WritingAlternative],
    ghosts: &[WritingGhost],
) -> EncodedWritingRanges {
    let frag = snapshot.get_or_insert_xml_fragment(fragment);
    if crate::markdown::limits::fragment_too_deep(&snapshot.transact(), &frag) {
        // The read that follows fails closed on a tree this deep.
        return EncodedWritingRanges {
            sentinels: WritingSentinelMap::new(),
            alternatives: Vec::new(),
        };
    }
    let mut runs: Vec<TextRun> = Vec::new();
    let mut ranges: Vec<ResolvedRange> = Vec::new();
    let mut shown: Vec<(WritingAlternative, String)> = Vec::new();
    {
        let txn = snapshot.transact();
        collect_text_runs(&frag, &txn, &mut runs);
        for record in alternatives {
            if !is_writing_alternative_id(&record.id) {
                continue;
            }
            let Some((start, end)) =
                resolve_range(&txn, &runs, &record.anchor_start, &record.anchor_end)
            else {
                continue;
            };
            ranges.push(ResolvedRange {
                kind: WritingMarkerKind::Alt,
                key: record.id.clone(),
                start,
                end,
            });
            shown.push((record.clone(), text_between(&runs, start, end)));
        }
        for (index, record) in ghosts.iter().enumerate() {
            if let Some((start, end)) =
                resolve_range(&txn, &runs, &record.anchor_start, &record.anchor_end)
            {
                ranges.push(ResolvedRange {
                    kind: WritingMarkerKind::Ghost,
                    key: format!("g{index}"),
                    start,
                    end,
                });
            }
        }
    }
    let all_plain: String = runs
        .iter()
        .map(|r| String::from_utf16_lossy(&r.plain))
        .collect();
    let mut allocate = create_sentinel_allocator(&all_plain);

    let mut sentinels = WritingSentinelMap::new();
    let mut emitted: Vec<String> = Vec::new();
    // At one position: closes before opens, the inner range's close first, the
    // outer range's open first, so ranges that touch or nest stay well formed.
    type Order = (i64, i64, i64);
    let mut inserts: Vec<(usize, usize, char, Order)> = Vec::new();
    for range in &ranges {
        let Some(open) = allocate() else { break };
        let Some(close) = allocate() else { break };
        sentinels.insert(
            open,
            WritingMarker {
                kind: range.kind,
                key: range.key.clone(),
                open: true,
            },
        );
        sentinels.insert(
            close,
            WritingMarker {
                kind: range.kind,
                key: range.key.clone(),
                open: false,
            },
        );
        if range.kind == WritingMarkerKind::Alt {
            emitted.push(range.key.clone());
        }
        let (s, e) = (range.start, range.end);
        inserts.push((
            s.run,
            s.index,
            open,
            (1, -(e.run as i64), -(e.index as i64)),
        ));
        inserts.push((
            e.run,
            e.index,
            close,
            (0, -(s.run as i64), -(s.index as i64)),
        ));
    }
    let mut txn = snapshot.transact_mut();
    let mut runs_touched: Vec<usize> = inserts.iter().map(|i| i.0).collect();
    runs_touched.sort_unstable();
    runs_touched.dedup();
    for run in runs_touched {
        let mut indices: Vec<usize> = inserts.iter().filter(|i| i.0 == run).map(|i| i.1).collect();
        indices.sort_unstable_by(|a, b| b.cmp(a));
        indices.dedup();
        for index in indices {
            let mut here: Vec<&(usize, usize, char, Order)> = inserts
                .iter()
                .filter(|i| i.0 == run && i.1 == index)
                .collect();
            here.sort_by_key(|i| i.3);
            let text: String = here.iter().map(|i| i.2).collect();
            runs[run].text.insert(&mut txn, index as u32, &text);
        }
    }
    EncodedWritingRanges {
        sentinels,
        alternatives: shown
            .into_iter()
            .filter(|(record, _)| emitted.contains(&record.id))
            .collect(),
    }
}

/// `writingFrontmatterFor`: the `writing` frontmatter for what the body
/// carries plus the overflow list.
pub fn writing_frontmatter_for(
    alternatives: &[(WritingAlternative, String)],
    overflow: &[WritingOverflowItem],
) -> WritingFrontmatter {
    let mut entries: Vec<(String, WritingFrontmatterAlternative)> = alternatives
        .iter()
        .map(|(record, shown)| {
            let versions = record
                .variants
                .iter()
                .map(|v| WritingFrontmatterVersion {
                    text: v.text.clone(),
                    ai: (v.source == "ai").then_some(true),
                })
                .collect();
            let original = (*shown != record.original).then(|| record.original.clone());
            (
                record.id.clone(),
                WritingFrontmatterAlternative { original, versions },
            )
        })
        .collect();
    // `Object.fromEntries`: a repeated key keeps its first position, last value.
    let mut unique: Vec<(String, WritingFrontmatterAlternative)> = Vec::new();
    for (key, value) in entries.drain(..) {
        match unique.iter().position(|(k, _)| *k == key) {
            Some(at) => unique[at].1 = value,
            None => unique.push((key, value)),
        }
    }
    js_entry_order(&mut unique);
    let mut sorted: Vec<&WritingOverflowItem> = overflow.iter().collect();
    sorted.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
    WritingFrontmatter {
        alternatives: unique,
        overflow: sorted
            .into_iter()
            .map(|item| WritingFrontmatterOverflowItem {
                text: item.text.clone(),
                label: item.label.clone().filter(|l| !l.is_empty()),
            })
            .collect(),
    }
}
