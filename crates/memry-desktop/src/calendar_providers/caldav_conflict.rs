//! A queued CalDAV update and the 412 it can meet (`pushEventWithConflictRetry` with
//! `threeWayMerge`, `push-conflict-retry.ts`). Electron fetches the server's copy, merges it into
//! the item field by field against the last pushed copy and sends again with the fresh ETag; here
//! the core merges (`VaultCalendar::caldav_merge_conflict`) and the update retries once. A retry
//! that conflicts again leaves the item queued and flags its calendar for the pass's sync state.

use memry_core::api::calendar_provider_sync::CalendarPushPlan;
use memry_core::api::calendar_records::CalendarSourceRecord;

use super::caldav_dav::{self, DavError, Precondition};
use super::caldav_push::{Item, Outcome, Pass, dav_object};
use super::caldav_sync::{CaldavSync, SyncError, blocking, now_ms};
use super::caldav_transport::Transport;
use super::zones::feed_zones;

impl CaldavSync {
    pub(super) async fn update(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        held: &[String],
        source: &CalendarSourceRecord,
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Outcome, SyncError> {
        match self.put(pass, item, plan, transport).await? {
            Some(outcome) => Ok(outcome),
            None => {
                self.merge_and_retry(pass, item, held, source, plan, transport)
                    .await
            }
        }
    }

    /// The `PUT` with `If-Match`, recorded when it lands; `None` on a 412.
    async fn put(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Option<Outcome>, SyncError> {
        let (Some(href), Some(body), Some(if_match)) = (
            plan.href.as_deref(),
            plan.body.as_deref(),
            plan.if_match.as_deref(),
        ) else {
            return self.skip(pass, item).await.map(Some);
        };
        match caldav_dav::put(transport, href, body, Precondition::Match(if_match)).await {
            Ok(etag) => {
                let (etag, data) = Self::written(transport, href, body, etag).await?;
                let remote = plan
                    .remote_event_id
                    .clone()
                    .unwrap_or_else(|| href.to_owned());
                self.done(pass, item, &plan.calendar_id, &remote, etag, data)
                    .await
                    .map(Some)
            }
            Err(DavError::Conflict) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    async fn merge_and_retry(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        held: &[String],
        source: &CalendarSourceRecord,
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Outcome, SyncError> {
        let href = plan.href.clone().unwrap_or_default();
        let Some(object) = caldav_dav::get(transport, &href).await? else {
            return self.gone(pass, item, source, plan, &href).await;
        };
        let zones = feed_zones(&object.data, now_ms());
        let (writer, t, id, fresh) = (
            pass.calendar.clone(),
            item.source_type.to_owned(),
            item.source_id.to_owned(),
            dav_object(object),
        );
        let base = fresh.clone();
        let stamp = blocking(move || writer.caldav_merge_conflict(t, id, fresh, zones)).await??;
        let item = Item {
            source_type: item.source_type,
            source_id: item.source_id,
            queued_at: stamp.unwrap_or(item.queued_at),
        };
        let plan = self.plan(pass, &item, held, Some(base)).await?;
        if plan.action != "upsert" || plan.if_match.is_none() {
            return self.skip(pass, &item).await;
        }
        match self.put(pass, &item, &plan, transport).await? {
            Some(outcome) => Ok(outcome),
            None => {
                pass.needs_attention(source);
                Err(DavError::Conflict.into())
            }
        }
    }
}
