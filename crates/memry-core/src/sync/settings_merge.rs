//! `settings` inbound: chapter 06 §6.9's dotted-path field clocks, and the
//! third and last row of §6.8's table (FR-002, FR-033, FR-059, FR-063).
//!
//! §6.8 names three algorithms. `task` and `project` are field-merged over a
//! declared list ([`crate::domain::task_merge`]), every other subscribed type
//! runs §6.3.1's document gate, and `settings` is this file. It was the row
//! that did not do what the table said: the inbound path stored the remote
//! settings payload **wholesale**, so a theme changed here vanished the moment
//! a peer that had not seen it pushed anything.
//!
//! ## What §6.9 changes, and what it does not
//!
//! §6.9 changes the **key space** and nothing else. Its clocks are "field
//! clocks" keyed by **dotted path at arbitrary depth** rather than by a name
//! from a fixed list, and the whole blob is one sync item (§13.6, §13.7.13).
//! The chapter states no separate winner rule for them, so the winner rule is
//! the one §6.3 states for field clocks — tick sum, the asymmetric `_offline`
//! key-presence tie-break, remote as the default on a tie, and `merge(L, R)`
//! written back unconditionally on every path (§6.3 steps 1 to 7). That rule
//! lives in [`crate::sync::field_merge::merge_fields`] and is **not restated
//! here**: it is pinned byte for byte by the `field-merge` vector class, and a
//! second copy of it is a second thing to get wrong. This file supplies the
//! path key space, the nested value access, and the storage around both.
//!
//! **There is no document gate to run first.** `settings` is the one record
//! type exempt from the clock requirement (§13.9, and chapter 00 §0.7 through
//! `packages/contracts/src/sync-api.ts:64-89`), and §13.7.13's payload is
//! `{ settings, fieldClocks }` with no `clock` key at all. §6.3.1's first row
//! — "local clock is null or absent → apply the remote wholesale" — would
//! therefore fire on **every** settings pull and undo the merge below. The
//! per-path clocks are the whole mechanism.
//!
//! ## The sub-objects that are single-clocked on purpose
//!
//! `sidebar.sectionOrder` and `sidebar.navCollapsed` are one clock each for a
//! whole value, while `journal.weekdayTemplates.<day>` carries a clock per day
//! (§6.9). **Nothing here models that distinction, and that is the point.**
//! §6.9.1 says a write clocks the path it wrote and never an ancestor, so the
//! *declared* path is whatever key the writer put in `fieldClocks`: the
//! section order arrives as one key `sidebar.sectionOrder` whose value is the
//! whole list, and Wednesday arrives as `journal.weekdayTemplates.3`. Deriving
//! the merge unit from the clock key rather than from a table is what stops
//! two partial sidebar orders interleaving, and it needs no list to maintain.
//!
//! ## Four rules that bite
//!
//! - **Absent wins mean removal, not "leave the column alone".** §6.3 step 8's
//!   spread leaves a task column untouched when the winner is `undefined`,
//!   because an absent task field means "the sender does not model it"
//!   (§13.4). A settings payload carries every setting its sender holds —
//!   §13.2 preserves even the ones it cannot model — so an absent value under
//!   a clock the sender **ticked** is a removal. §6.9.1 requires a removal to
//!   tick and says in as many words that a removal which ticks nothing "loses
//!   to the peer still holding the old value"; the inbound side is where that
//!   win has to actually happen, or the two devices diverge permanently.
//! - **Nothing is pruned.** §6.9.1 leaves the clocks under a replaced subtree
//!   explicitly undefined and forbids inventing a rule, so every clock in
//!   either payload comes out in the merged map, including ones for paths this
//!   build cannot address.
//! - **The base is the local payload.** §6.9.2: a field merge keeps the local
//!   copy's unmodelled keys and does not carry the remote's. Only the paths
//!   the clocks arbitrate are written, and an unmodelled *group* the remote
//!   clocked — `experimental` — rides along through exactly that door rather
//!   than through a group list (§13.10, #2183).
//! - **A clock that will not read is [`Inbound::Corrupt`], never an empty
//!   clock.** An empty map reads as "this side has nothing", which hands a
//!   stale remote every path — the bug this file exists to fix (§6.10).
//!   An **absent** `fieldClocks` key is a different thing and is legitimately
//!   the empty map: §6.3 step 1's "a missing field clock is the empty clock",
//!   and the committed `settings: boundary` vector is exactly that payload.
//!
//! **Nothing here enqueues** (§6.5.2 P3). The merging device stores the union
//! clocks and does not re-push; an [`crate::sync::outbox::enqueue`] appearing
//! in this file is the §6.5.1 case-3c divergence coming back, not a
//! convenience.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::settings::{
    apply_at, field_clocks_of, read_clock, segments, settings_of, value_at,
};
use crate::domain::task_merge;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::VectorClock;
use crate::sync::field_merge::merge_fields;

/// §6.8's third row, for one inbound `settings` record.
///
/// Three short-circuits come before the merge and each is a rule:
///
/// - **a tombstone bypasses it entirely** (§6.9.2, §13.7.2): a deleted row has
///   no settings to arbitrate and no clocks to read;
/// - **nothing local to merge against** — no row, or a row whose body has not
///   been pulled yet — is a wholesale store of the remote bytes;
/// - **a local payload that is not JSON** is already flagged corrupt, so the
///   remote is the better copy and applies wholesale. This is the same call
///   [`crate::domain::task_merge`] makes, for the same reason.
///
/// A **remote** that is not JSON goes down the wholesale path too, where
/// [`sync_items::apply_remote`] stores the bytes and records the reason
/// against the row (§13.2 rule 5). A remote that *is* JSON but whose
/// `settings` or `fieldClocks` will not read is an `Err`, which the caller
/// records corrupt **without** overwriting the local payload.
pub(crate) fn apply_remote_merged(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    if record.deleted_at.is_some() {
        return task_merge::wholesale(conn, record, now_ms);
    }
    let Some(local) = live_payload(conn, record)? else {
        return task_merge::wholesale(conn, record, now_ms);
    };
    let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
        return task_merge::wholesale(conn, record, now_ms);
    };

    let merged = merge(local.object(), remote.object())?;
    if !merged.changed {
        // Every path the clocks arbitrate resolved to what this device already
        // holds, and the union added no tick. The local value stands, nothing
        // is written, and the pull still counts the row and advances past it
        // (§5.14, FR-032).
        return Ok(Inbound::Skipped);
    }

    let changes = [
        ("settings", Change::Set(Value::Object(merged.settings))),
        ("fieldClocks", Change::Set(merged.field_clocks)),
    ];

    // One transaction, and **no outbox row**: §6.5.2 P3.
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    sync_items::apply_local_edit_in(
        &transaction,
        &record.item_type,
        &record.item_id,
        &changes,
        now_ms,
    )?;
    // The bookkeeping the wholesale path would have written. `deleted_at` is
    // untouched: this branch cannot be a tombstone.
    transaction
        .execute(
            "UPDATE sync_items SET server_cursor = ?3, signer_device_id = ?4, updated_at = ?5
             WHERE item_type = ?1 AND item_id = ?2",
            params![
                record.item_type,
                record.item_id,
                record.server_cursor,
                record.signer_device_id,
                record.updated_at,
            ],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)?;

    // `Inbound::Merged`'s conflict set is deliberately not produced here.
    // §6.9 defines no conflict surface for settings, and §6.3.1's core
    // obligation is that the core writes conflicts nowhere: desktop's
    // `superseded` rows sync to every device as `task_activity`.
    Ok(Inbound::Applied)
}

/// The merged `settings` object and `fieldClocks` map, and whether either
/// differs from what this device already holds.
struct MergedSettings {
    settings: Map<String, Value>,
    field_clocks: Value,
    changed: bool,
}

/// §6.9's merge over the union of both payloads' clocked paths.
fn merge(local: &Object, remote: &Object) -> Result<MergedSettings, StorageError> {
    let local_settings = settings_of(local)?;
    let remote_settings = settings_of(remote)?;
    let local_clocks = clocks_of(local)?;
    let remote_clocks = clocks_of(remote)?;

    // The clock keys **are** the field list: §6.9.1's "a write clocks the path
    // it wrote" means the set of clocked paths is the set of merge units, and
    // a `BTreeSet` fixes the order so the applies below are deterministic.
    let paths: Vec<String> = local_clocks
        .keys()
        .chain(remote_clocks.keys())
        .cloned()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();

    let result = merge_fields(
        &flatten(&local_settings, &paths),
        &flatten(&remote_settings, &paths),
        &local_clocks,
        &remote_clocks,
        &paths,
    );

    let mut settings = local_settings.clone();
    for path in &paths {
        // A clock key that is not an addressable path — `""`, `general.` —
        // arbitrates nothing and is refused nowhere: §6.9 says a key outside
        // the modelled set rides along rather than failing the payload, and
        // `result.merged_field_clocks` still carries its union below.
        let Ok(segments) = segments(path) else {
            continue;
        };
        let change = match result.merged.get(*path) {
            Some(value) => Change::Set(value.clone()),
            // §6.9.1: an absent winner under an arbitrated clock is a removal.
            None => Change::Remove,
        };
        apply_at(&mut settings, &segments, &change, path)?;
    }

    let changed = settings != local_settings || result.merged_field_clocks != local_clocks;
    Ok(MergedSettings {
        settings,
        field_clocks: as_json(&result.merged_field_clocks)?,
        changed,
    })
}

/// The values at `paths`, keyed by the dotted path itself, so §6.3's flat
/// per-field rule can read them.
///
/// A path with no value on this side is **absent** rather than `null`: §13.4's
/// distinction is the one `merge_fields` reads, and collapsing it would turn
/// every removal into an explicit clear.
fn flatten(settings: &Map<String, Value>, paths: &[&str]) -> Map<String, Value> {
    let mut flat = Map::new();
    for path in paths {
        let Ok(segments) = segments(path) else {
            continue;
        };
        if let Some(value) = value_at(settings, &segments) {
            flat.insert((*path).to_owned(), value.clone());
        }
    }
    flat
}

/// One payload's `fieldClocks` as clocks. An unreadable one is a hard error,
/// never an empty map (§6.10).
fn clocks_of(object: &Object) -> Result<BTreeMap<String, VectorClock>, StorageError> {
    field_clocks_of(object)?
        .iter()
        .map(|(path, value)| Ok((path.clone(), read_clock(value, path)?)))
        .collect()
}

/// The stored payload of a live row that has one, or `None` when there is
/// nothing local to merge against.
fn live_payload(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(conn, &record.item_type, &record.item_id)? else {
        return Ok(None);
    };
    let Some(raw) = row.payload else {
        return Ok(None);
    };
    Ok(StoredPayload::parse(&raw).ok())
}

fn as_json<T: serde::Serialize>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value).map_err(|error| StorageError::Failed {
        what: format!("settings field clocks will not serialise: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Object {
        match value {
            Value::Object(object) => object,
            other => panic!("not an object: {other}"),
        }
    }

    fn merged(local: Value, remote: Value) -> MergedSettings {
        merge(&object(local), &object(remote)).expect("the merge")
    }

    #[test]
    fn a_dominating_local_path_survives_a_stale_remote_payload() {
        let outcome = merged(
            json!({
                "settings": {"general": {"theme": "light"}},
                "fieldClocks": {"general.theme": {"device-a": 2}}
            }),
            json!({
                "settings": {"general": {"theme": "dark"}},
                "fieldClocks": {"general.theme": {"device-a": 1}}
            }),
        );
        assert_eq!(outcome.settings["general"]["theme"], json!("light"));
        assert!(
            !outcome.changed,
            "nothing moved, so the apply is a skip rather than a write"
        );
    }

    #[test]
    fn two_devices_editing_two_paths_both_keep_their_edit() {
        let outcome = merged(
            json!({
                "settings": {"journal": {"weekdayTemplates": {"3": "wed-local"}}},
                "fieldClocks": {"journal.weekdayTemplates.3": {"device-a": 1}}
            }),
            json!({
                "settings": {"journal": {"weekdayTemplates": {"4": "thu-remote"}}},
                "fieldClocks": {"journal.weekdayTemplates.4": {"device-b": 1}}
            }),
        );
        assert_eq!(
            outcome.settings["journal"]["weekdayTemplates"],
            json!({"3": "wed-local", "4": "thu-remote"}),
            "§6.9: a clock per day is what lets two days both survive"
        );
        assert!(outcome.changed);
    }

    #[test]
    fn a_single_clocked_sub_object_moves_as_one_and_never_interleaves() {
        let outcome = merged(
            json!({
                "settings": {"sidebar": {"sectionOrder": ["notes", "tasks", "calendar"]}},
                "fieldClocks": {"sidebar.sectionOrder": {"device-a": 1}}
            }),
            json!({
                "settings": {"sidebar": {"sectionOrder": ["calendar", "notes", "tasks"]}},
                "fieldClocks": {"sidebar.sectionOrder": {"device-b": 2}}
            }),
        );
        assert_eq!(
            outcome.settings["sidebar"]["sectionOrder"],
            json!(["calendar", "notes", "tasks"]),
            "the last device to drag wins the whole list (§6.9)"
        );
    }

    #[test]
    fn a_removal_that_ticked_beats_the_peer_still_holding_the_old_value() {
        // The seat that receives the removal. §6.9.1: with the tick, it lands.
        let outcome = merged(
            json!({
                "settings": {"general": {"theme": "dark"}},
                "fieldClocks": {"general.theme": {"device-a": 1}}
            }),
            json!({
                "settings": {"general": {}},
                "fieldClocks": {"general.theme": {"device-a": 1, "device-b": 1}}
            }),
        );
        assert_eq!(outcome.settings["general"], json!({}));
        assert_eq!(
            outcome.field_clocks["general.theme"],
            json!({"device-a": 1, "device-b": 1})
        );

        // And the seat that made it: the stale value must not resurrect.
        let back = merged(
            json!({
                "settings": {"general": {}},
                "fieldClocks": {"general.theme": {"device-a": 1, "device-b": 1}}
            }),
            json!({
                "settings": {"general": {"theme": "dark"}},
                "fieldClocks": {"general.theme": {"device-a": 1}}
            }),
        );
        assert_eq!(back.settings["general"], json!({}));
        assert!(!back.changed);
    }

    #[test]
    fn an_unmodelled_group_the_remote_clocked_rides_along() {
        let outcome = merged(
            json!({
                "settings": {"general": {"theme": "dark"}},
                "fieldClocks": {"general.theme": {"device-a": 1}}
            }),
            json!({
                "settings": {
                    "general": {"theme": "dark"},
                    "experimental": {"agentSidebar": true}
                },
                "fieldClocks": {
                    "general.theme": {"device-a": 1},
                    "experimental.agentSidebar": {"device-b": 1}
                }
            }),
        );
        assert_eq!(
            outcome.settings["experimental"],
            json!({"agentSidebar": true}),
            "#2183's failure mode: a merge must not strip a group it cannot model"
        );
    }

    #[test]
    fn the_local_copys_unclocked_keys_are_kept_and_the_remotes_are_not() {
        // §6.9.2. Neither side clocked these, so neither is arbitrated.
        let outcome = merged(
            json!({
                "settings": {"notes": {"localOnly": 1}},
                "fieldClocks": {}
            }),
            json!({
                "settings": {"notes": {"remoteOnly": 2}},
                "fieldClocks": {}
            }),
        );
        assert_eq!(outcome.settings["notes"], json!({"localOnly": 1}));
        assert!(!outcome.changed);
    }

    #[test]
    fn a_clock_key_that_is_not_a_path_rides_along_rather_than_failing_the_payload() {
        let outcome = merged(
            json!({"settings": {}, "fieldClocks": {}}),
            json!({"settings": {}, "fieldClocks": {"general.": {"device-b": 1}}}),
        );
        assert_eq!(
            outcome.field_clocks["general."],
            json!({"device-b": 1}),
            "§6.9: a key outside the modelled set must not fail the payload"
        );
    }

    #[test]
    fn a_clock_that_will_not_read_is_an_error_and_never_an_empty_clock() {
        assert!(
            merge(
                &object(json!({"settings": {}, "fieldClocks": {"general.theme": "nope"}})),
                &object(json!({"settings": {}, "fieldClocks": {}})),
            )
            .is_err()
        );
        assert!(
            merge(
                &object(json!({"settings": {}, "fieldClocks": []})),
                &object(json!({"settings": {}, "fieldClocks": {}})),
            )
            .is_err()
        );
    }

    /// The shared `settings-merge` vectors (#2383), generated from desktop's
    /// merge. [`merge`] is private, so the file is read here rather than from
    /// `tests/`. Only `settings` and `fieldClocks` are asserted: `requeue` is
    /// §6.9.0's re-queue, which this file does not do (see the module docs).
    /// A `rustPending` case is one this core still resolves differently and
    /// is asserted to differ, so fixing it here forces the flag off the case.
    #[test]
    fn the_shared_settings_merge_vectors_match_desktop() {
        let file: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/test-vectors/settings-merge.json"
        ))
        .expect("the committed vector file");
        let cases = file["cases"].as_array().expect("cases is an array");
        assert_eq!(cases.len() as u64, file["meta"]["caseCount"]);

        let mut pending = 0;
        for case in cases {
            let name = case["name"].as_str().expect("every case is named");
            let outcome = merged(case["local"].clone(), case["remote"].clone());
            let expected = &case["expected"];
            let matches = Value::Object(outcome.settings) == expected["settings"]
                && outcome.field_clocks == expected["fieldClocks"];
            if case.get("rustPending").is_some() {
                pending += 1;
                assert!(
                    !matches,
                    "{name}: fixed here, remove its `rustPending` flag"
                );
            } else {
                assert!(
                    matches,
                    "{name}: settings or field clocks differ from desktop"
                );
            }
        }
        assert_eq!(pending, 2, "the two absent-winner cases");
    }

    #[test]
    fn the_union_of_both_clocks_is_written_back_on_every_path() {
        // §6.3 step 7, unconditionally and whichever branch won. Dropping the
        // loser's ticks would lower `clockTotal` and hand the next peer a win.
        let outcome = merged(
            json!({
                "settings": {"general": {"theme": "light"}},
                "fieldClocks": {"general.theme": {"device-a": 3}}
            }),
            json!({
                "settings": {"general": {"theme": "dark"}},
                "fieldClocks": {"general.theme": {"device-b": 1}}
            }),
        );
        assert_eq!(outcome.settings["general"]["theme"], json!("light"));
        assert_eq!(
            outcome.field_clocks["general.theme"],
            json!({"device-a": 3, "device-b": 1})
        );
        assert!(outcome.changed, "the clock union alone is a write");
    }
}
