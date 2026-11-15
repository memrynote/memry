//! Reciprocal Rank Fusion of the semantic hits into the note, journal and inbox
//! groups: desktop's `fuseSemanticHits` (`search-semantic-merge.ts:150-204`).
//!
//! Ranks are merged, not scores (Cormack et al. 2009): an item at rank `r` of a list
//! scores `1 / (60 + r + 1)`, an item both lists hold scores the sum, and ties keep
//! the index's order ahead of the semantic order. An item both legs found keeps its
//! index item (snippet, score); an item only the vectors found keeps the empty
//! snippet [`super::items::semantic_items`] gave it. Tasks have no vectors.

use std::collections::HashMap;

use super::super::SearchType;
use super::{Group, GroupedItem};

/// `RRF_K` (`search-semantic-merge.ts:24`).
const RRF_K: f64 = 60.0;

/// One fused entry: the item, its summed RRF score, and its tie-break order.
struct Entry {
    item: GroupedItem,
    rrf: f64,
    order: usize,
}

/// Fuses `semantic` (per type, best first, already filtered) into `groups`, each cut
/// to `limit`. A type with no group yet gets one, placed in `active` order.
pub(super) fn fuse(
    groups: &mut Vec<Group>,
    semantic: Vec<(SearchType, Vec<GroupedItem>)>,
    active: &[SearchType],
    limit: usize,
) {
    for (kind, items) in semantic {
        if items.is_empty() || !active.contains(&kind) || kind == SearchType::Task {
            continue;
        }
        let at = groups.iter().position(|group| group.kind == kind);
        let before = at.map_or_else(Vec::new, |at| std::mem::take(&mut groups[at].results));
        let first_semantic = before.len();
        let mut entries: Vec<Entry> = Vec::with_capacity(before.len() + items.len());
        let mut by_id: HashMap<String, usize> = HashMap::new();
        for (rank, item) in before.into_iter().enumerate() {
            by_id.insert(item.id.clone(), entries.len());
            entries.push(Entry {
                item,
                rrf: rrf(rank),
                order: rank,
            });
        }
        for (rank, item) in items.into_iter().enumerate() {
            match by_id.get(&item.id) {
                Some(&at) => entries[at].rrf += rrf(rank),
                None => {
                    by_id.insert(item.id.clone(), entries.len());
                    entries.push(Entry {
                        item,
                        rrf: rrf(rank),
                        order: first_semantic + rank,
                    });
                }
            }
        }
        entries.sort_by(|a, b| b.rrf.total_cmp(&a.rrf).then(a.order.cmp(&b.order)));
        let results: Vec<GroupedItem> = entries
            .into_iter()
            .take(limit)
            .map(|entry| entry.item)
            .collect();
        match at {
            Some(at) => groups[at].results = results,
            None => {
                let rank = |kind: SearchType| active.iter().position(|other| *other == kind);
                let at = groups
                    .iter()
                    .position(|other| rank(other.kind) > rank(kind))
                    .unwrap_or(groups.len());
                groups.insert(at, Group { kind, results });
            }
        }
    }
}

fn rrf(rank: usize) -> f64 {
    1.0 / (RRF_K + rank as f64 + 1.0)
}
