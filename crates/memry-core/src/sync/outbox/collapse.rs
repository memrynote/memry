//! One push item per `(item_type, item_id)` (split from [`super`] at the 600-line ceiling).

use std::collections::HashMap;

use super::{OP_CREATE, OP_UPSERT, OutboxRow};

/// One record row to send, plus the older rows it stands for.
///
/// The push response is per item id, so two rows sharing an id cannot be told
/// apart in a mixed accept-and-reject response (§A.2). The newest row is sent
/// and the rest ride its verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collapsed {
    pub row: OutboxRow,
    /// Older rows for the same `(item_type, item_id)`. Acked with `row`,
    /// never sent.
    pub superseded: Vec<i64>,
}

impl Collapsed {
    /// Every outbox id this push item accounts for.
    pub fn ids(&self) -> Vec<i64> {
        let mut ids = vec![self.row.id];
        ids.extend_from_slice(&self.superseded);
        ids
    }
}

/// Collapses record rows to one per `(item_type, item_id)`, keeping the
/// newest — the highest `id`, which is the insertion order (§A.2).
///
/// An upsert that supersedes a `create` is sent as the create: the item was
/// never sent, and only a `create` re-creates it over a purged tombstone
/// (chapter 05 §5.12.3).
///
/// CRDT rows are returned untouched and uncollapsed; collapsing them would
/// drop updates a peer has not seen.
pub fn collapse_records(rows: Vec<OutboxRow>) -> Vec<Collapsed> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut grouped: HashMap<(String, String), Vec<OutboxRow>> = HashMap::new();
    for row in rows {
        if row.is_crdt() {
            continue;
        }
        let key = (row.item_type.clone(), row.item_id.clone());
        if !grouped.contains_key(&key) {
            order.push(key.clone());
        }
        grouped.entry(key).or_default().push(row);
    }

    order
        .into_iter()
        .filter_map(|key| {
            let mut rows = grouped.remove(&key)?;
            rows.sort_by_key(|row| row.id);
            let mut newest = rows.pop()?;
            if newest.op == OP_UPSERT && rows.iter().any(|row| row.op == OP_CREATE) {
                newest.op = OP_CREATE.to_owned();
            }
            Some(Collapsed {
                row: newest,
                superseded: rows.into_iter().map(|row| row.id).collect(),
            })
        })
        .collect()
}
