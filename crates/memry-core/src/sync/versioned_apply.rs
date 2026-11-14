//! Chapter 06 §6.11.2 and §6.11.4 on an inbound record: a versioned key
//! (`task.fields`, `tag_definition.schema`) joins by its own versions on every
//! branch (insert, wholesale, merge and skip), and a join that leaves the
//! remote behind is re-pushed.
//!
//! Twin of the `joinVersioned*` / `owesHeal` steps in desktop's
//! `apps/desktop/src/main/sync/item-handlers/task-handler.ts` and
//! `tag-definition-handler.ts`. It runs after the type's apply, which stores
//! the remote's value on a wholesale apply and keeps the local one on a skip;
//! this step writes the join over whichever it kept.
//!
//! A heal is the one enqueue an inbound apply makes, and §6.11.4 bounds it:
//! never on an insert, a skip, a remote `null` or a merge with conflicts
//! (§6.5.2 P3), so two clients never ping-pong. It ticks this device into
//! the document clock, which is what lets the re-push pass the server's
//! replay check, and names no changed field, so no field clock ticks.

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, next_clock};
use crate::domain::tag_admin::DEFINITION_TYPE;
use crate::domain::tasks::{self, Inbound};
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::field_merge::canonical_json;
use crate::sync::outbox;
use crate::sync::versioned::{self, Joined};

/// One versioned key of one item type, and the join it merges by.
pub(crate) struct VersionedKey {
    pub(crate) item_type: &'static str,
    pub(crate) key: &'static str,
    pub(crate) join: fn(Option<&Value>, Option<&Value>) -> Joined,
}

/// `task.fields` (§13.7.3.1).
pub(crate) const TASK_FIELDS: VersionedKey = VersionedKey {
    item_type: tasks::ITEM_TYPE,
    key: "fields",
    join: versioned::join_map,
};

/// `tag_definition.schema` (§13.7.7.1).
pub(crate) const TAG_SCHEMA: VersionedKey = VersionedKey {
    item_type: DEFINITION_TYPE,
    key: "schema",
    join: versioned::join_value,
};

impl VersionedKey {
    /// The local value before the apply: `None` when there is no live local
    /// row (an insert), `Some(None)` when the row holds no value.
    pub(crate) fn local(
        &self,
        conn: &Connection,
        record: &InboundRecord,
    ) -> Result<Option<Option<Value>>, StorageError> {
        let Some(row) = sync_items::load(conn, self.item_type, &record.item_id)? else {
            return Ok(None);
        };
        if row.deleted_at.is_some() {
            return Ok(None);
        }
        let Some(payload) = row.payload.and_then(|raw| StoredPayload::parse(&raw).ok()) else {
            return Ok(None);
        };
        Ok(Some(payload.object().get(self.key).cloned()))
    }

    /// Writes the join of `local` and the remote's value over what the apply
    /// kept, and heals when §6.11.4 owes one.
    pub(crate) fn join_after_apply(
        &self,
        conn: &Connection,
        record: &InboundRecord,
        local: Option<Option<Value>>,
        inbound: &Inbound,
        clock_device: Option<&str>,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let Some(local) = local else {
            return Ok(());
        };
        if record.deleted_at.is_some() || matches!(inbound, Inbound::Corrupt { .. }) {
            return Ok(());
        }
        let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
            return Ok(());
        };
        let joined = (self.join)(local.as_ref(), remote.object().get(self.key));
        let stored = sync_items::load(conn, self.item_type, &record.item_id)?
            .and_then(|row| row.payload)
            .and_then(|raw| StoredPayload::parse(&raw).ok());
        let Some(stored) = stored else {
            return Ok(());
        };
        let kept = stored.object().get(self.key).cloned();
        let rewrite = joined.value.is_some()
            && joined.value.as_ref().map(canonical_json) != kept.as_ref().map(canonical_json);
        let heal = joined.remote_behind
            && match inbound {
                Inbound::Applied => true,
                Inbound::Merged { conflicted_fields } => conflicted_fields.is_empty(),
                Inbound::Skipped | Inbound::Corrupt { .. } | Inbound::Refused => false,
            };

        let mut changes: Vec<(&str, Change)> = Vec::new();
        if rewrite && let Some(value) = joined.value {
            changes.push((self.key, Change::Set(value)));
        }
        let heal_device = clock_device.filter(|_| heal);
        if let Some(device) = heal_device {
            changes.push(("clock", Change::Set(next_clock(stored.object(), device)?)));
        }
        if changes.is_empty() {
            return Ok(());
        }
        let write = |tx: &Connection| {
            sync_items::apply_local_edit_in(tx, self.item_type, &record.item_id, &changes, now_ms)
        };
        if heal_device.is_some() {
            outbox::commit(
                conn,
                &outbox::Change::upsert(self.item_type, &record.item_id),
                now_ms,
                write,
            )?
            .acknowledge();
        } else {
            let transaction = conn.unchecked_transaction().map_err(failed)?;
            write(&transaction)?;
            transaction.commit().map_err(failed)?;
        }
        Ok(())
    }
}
