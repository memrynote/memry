//! The durable push drain for CalDAV (`caldav/caldav-write.ts`, `provider/write-dispatch.ts`).
//! Electron pushed each local change fire-and-forget; here every local change waits in the core's
//! `calendar_push_queue` (queued by the outbox in the change's own transaction), and a drain
//! writes each item out: `push_plan` decides what to send (the core's routing, one writer per
//! item), this module makes the request, then `push_done`, `push_deleted`, `push_skip` or
//! `push_failed` records the answer. A row leaves the queue only once its write is recorded.
//!
//! Only items a Memry change queued are written, and only to the object their binding names (or
//! a new object under a fresh UID): a mirrored event is never written to.
//!
//! **Crash recovery.** A create mints a new UID per plan, so a create whose `PUT` landed but whose
//! `push_done` did not (the app died, the answer was lost) would be created again. Before the
//! `PUT`, the create's href is kept in the device-local `calendar.caldav.pendingCreates`; the next
//! plan of the item that is still a create first `GET`s that href, records the object found there
//! and sends nothing. An update or delete needs no journal: a replay carries the old ETag and
//! takes the conflict path, a delete of an object already gone counts as deleted.
//!
//! **Conflicts.** A 412 never overwrites the remote: an update that meets one takes the object the
//! server holds now through the pull (`caldav_apply_pull`, which writes it back into the item); a
//! delete that meets one keeps the remote object and retires the binding, so the next pull mirrors
//! it; excluding one occurrence retries once on the fresh object, which leaves the rest of it.

use std::sync::Arc;

use memry_core::api::calendar::VaultCalendar;
use memry_core::api::calendar_provider_sync::{CalendarCaldavObject, CalendarPushPlan};
use memry_core::api::calendar_records::CalendarSourceRecord;
use memry_core::domain::calendar_items::providers::CALDAV;
use serde_json::{Map, Value, json};

use super::caldav_dav::{self, DavError, Precondition};
use super::caldav_sync::{
    CaldavSync, SyncError, apply_objects, blocking, live, now_ms,
};
use super::caldav_transport::Transport;
use super::zones::named_zones;
use crate::session::OpenVault;

const SCOPE: &str = "calendar_caldav_push";
/// The creates whose `PUT` may have landed without being recorded, by `<type>:<id>`.
pub const PENDING_CREATES_KEY: &str = "calendar.caldav.pendingCreates";

/// One drain's count.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DrainSummary {
    pub pushed: u32,
    pub skipped: u32,
    pub waiting: u32,
    pub failed: u32,
}

/// What one item came to.
enum Outcome {
    Pushed,
    Skipped,
    Waiting,
}

struct Item<'a> {
    source_type: &'a str,
    source_id: &'a str,
}

impl Item<'_> {
    fn key(&self) -> String {
        format!("{}:{}", self.source_type, self.source_id)
    }
}

/// The pass's view of this device: its sources, the accounts the server refused.
struct Pass {
    calendar: Arc<VaultCalendar>,
    sources: Vec<CalendarSourceRecord>,
    failures: Map<String, Value>,
}

impl Pass {
    fn calendar_source(&self, remote: &str) -> Option<&CalendarSourceRecord> {
        self.sources
            .iter()
            .find(|s| live(s, "calendar") && s.remote_id == remote)
    }

    fn account(&self, id: &str) -> Option<&CalendarSourceRecord> {
        self.sources
            .iter()
            .find(|s| live(s, "account") && s.account_id.as_deref() == Some(id))
    }
}

impl CaldavSync {
    /// Writes out every queued item routed to a CalDAV calendar this device can write to. A rate
    /// limit, an unreachable server or a refused password ends the pass with the item still
    /// queued; any other failure stays on its item and the pass goes on.
    pub async fn drain(&self, open: &OpenVault) -> Result<DrainSummary, SyncError> {
        let _one = self.draining.lock().await;
        let calendar = self.calendar(open).await?;
        let reader = calendar.clone();
        let sources = blocking(move || reader.sources()).await??;
        let pass = Pass {
            calendar,
            sources,
            failures: self.auth_failures(open).await?,
        };
        let reader = pass.calendar.clone();
        let enabled = blocking(move || reader.setting("calendar.caldav.pushEventsToProvider".into()))
            .await??
            .is_none_or(|v| v != "false");
        let mut held = Vec::new();
        for account in pass.sources.iter().filter(|s| live(s, "account")) {
            if self.usable(&pass, account).await?.is_some() {
                held.push(CALDAV.to_owned());
                break;
            }
        }
        let reader = pass.calendar.clone();
        let queue = blocking(move || reader.push_queue()).await??;
        let mut summary = DrainSummary::default();
        for queued in &queue {
            let item = Item {
                source_type: &queued.source_type,
                source_id: &queued.source_id,
            };
            match self.push_one(open, &pass, &item, &held, enabled).await {
                Ok(Outcome::Pushed) => summary.pushed += 1,
                Ok(Outcome::Skipped) => summary.skipped += 1,
                Ok(Outcome::Waiting) => summary.waiting += 1,
                Err(error) => {
                    summary.failed += 1;
                    let halt = matches!(
                        error,
                        SyncError::Dav(
                            DavError::Auth(_) | DavError::RateLimited(_) | DavError::Transient(_)
                        )
                    );
                    tracing::warn!(
                        scope = SCOPE,
                        source_type = item.source_type,
                        attempts = queued.attempts,
                        "CalDAV push failed: {error}"
                    );
                    let (writer, t, id, text) = (
                        pass.calendar.clone(),
                        item.source_type.to_owned(),
                        item.source_id.to_owned(),
                        error.to_string(),
                    );
                    blocking(move || writer.push_failed(t, id, text)).await??;
                    if halt {
                        break;
                    }
                }
            }
        }
        Ok(summary)
    }

    /// `writableTransportFor`'s account half: a live account, not refused, with a password here.
    async fn usable(
        &self,
        pass: &Pass,
        account: &CalendarSourceRecord,
    ) -> Result<Option<Transport>, SyncError> {
        let id = account.account_id.as_deref().unwrap_or_default();
        if pass.failures.get(id) == Some(&Value::Bool(true)) {
            return Ok(None);
        }
        self.transport(account).await
    }

    async fn plan(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        held: &[String],
        base: Option<CalendarCaldavObject>,
    ) -> Result<CalendarPushPlan, SyncError> {
        let reader = pass.calendar.clone();
        let event = if item.source_type == "event" {
            let id = item.source_id.to_owned();
            blocking(move || reader.event(id)).await??
        } else {
            None
        };
        let zones = named_zones(event.and_then(|e| e.timezone), now_ms());
        let (writer, t, id, held) = (
            pass.calendar.clone(),
            item.source_type.to_owned(),
            item.source_id.to_owned(),
            held.to_vec(),
        );
        Ok(blocking(move || writer.push_plan(t, id, held, zones, base)).await??)
    }

    async fn push_one(
        &self,
        open: &OpenVault,
        pass: &Pass,
        item: &Item<'_>,
        held: &[String],
        enabled: bool,
    ) -> Result<Outcome, SyncError> {
        let mut plan = self.plan(pass, item, held, None).await?;
        if plan.provider != CALDAV || plan.action == "wait" {
            if plan.action == "none" {
                return self.skip(pass, item).await;
            }
            return Ok(Outcome::Waiting);
        }
        if plan.action == "none" {
            return self.skip(pass, item).await;
        }
        // The one-way switch turns every CalDAV write off (`isProviderPushEnabled`).
        if !enabled {
            return self.skip(pass, item).await;
        }
        let Some(source) = pass.calendar_source(&plan.calendar_id) else {
            tracing::info!(scope = SCOPE, "skipping a CalDAV write: the calendar is disconnected");
            return self.skip(pass, item).await;
        };
        let Some(account) = source.account_id.as_deref().and_then(|id| pass.account(id)) else {
            return self.skip(pass, item).await;
        };
        let Some(transport) = self.usable(pass, account).await? else {
            return Ok(Outcome::Waiting);
        };
        if plan.action == "fetch" {
            let href = plan.href.clone().unwrap_or_default();
            let Some(object) = caldav_dav::get(&transport, &href).await? else {
                return self.gone(pass, item, source, &plan, &href).await;
            };
            plan = self.plan(pass, item, held, Some(dav_object(object))).await?;
        }
        match plan.action.as_str() {
            "upsert" if plan.if_match.is_none() => {
                self.create(open, pass, item, &plan, &transport).await
            }
            "upsert" => self.update(pass, item, source, &plan, &transport).await,
            "delete" => self.delete(pass, item, &plan, &transport).await,
            "exclude" => self.exclude(pass, item, held, &plan, &transport).await,
            "none" => self.skip(pass, item).await,
            _ => Ok(Outcome::Waiting),
        }
    }

    async fn skip(&self, pass: &Pass, item: &Item<'_>) -> Result<Outcome, SyncError> {
        let (writer, t, id) = (
            pass.calendar.clone(),
            item.source_type.to_owned(),
            item.source_id.to_owned(),
        );
        blocking(move || writer.push_skip(t, id)).await??;
        Ok(Outcome::Skipped)
    }

    /// The bound object is gone from the server: a delete is done; an upsert applies the remote
    /// delete to the item, as a pull would (`applyProviderDelete`).
    async fn gone(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        source: &CalendarSourceRecord,
        plan: &CalendarPushPlan,
        href: &str,
    ) -> Result<Outcome, SyncError> {
        if let Some(binding) = plan.binding_id.clone() {
            return self.deleted(pass, item, binding).await;
        }
        let cursor = source.sync_cursor.clone();
        apply_objects(&pass.calendar, source, Vec::new(), vec![href.to_owned()], false, cursor)
            .await?;
        Ok(Outcome::Pushed)
    }

    async fn deleted(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        binding: String,
    ) -> Result<Outcome, SyncError> {
        let (writer, t, id) = (
            pass.calendar.clone(),
            item.source_type.to_owned(),
            item.source_id.to_owned(),
        );
        blocking(move || writer.push_deleted(t, id, binding)).await??;
        Ok(Outcome::Pushed)
    }

    async fn done(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        calendar_id: &str,
        remote_event_id: &str,
        etag: Option<String>,
        body: String,
    ) -> Result<Outcome, SyncError> {
        let reader = pass.calendar.clone();
        let event = if item.source_type == "event" {
            let id = item.source_id.to_owned();
            blocking(move || reader.event(id)).await??
        } else {
            None
        };
        let zones = named_zones(event.and_then(|e| e.timezone), now_ms());
        let (writer, t, id, calendar_id, remote) = (
            pass.calendar.clone(),
            item.source_type.to_owned(),
            item.source_id.to_owned(),
            calendar_id.to_owned(),
            remote_event_id.to_owned(),
        );
        blocking(move || {
            writer.push_done(t, id, CALDAV.to_owned(), calendar_id, remote, etag, Some(body), zones)
        })
        .await??;
        Ok(Outcome::Pushed)
    }

    /// `written`: a server that rewrote the object may answer without an ETag (RFC 4791
    /// §5.3.4); then its stored copy is read back, so the next write sends a real `If-Match`.
    async fn written(
        transport: &Transport,
        href: &str,
        sent: &str,
        etag: Option<String>,
    ) -> Result<(Option<String>, String), SyncError> {
        if etag.is_some() {
            return Ok((etag, sent.to_owned()));
        }
        Ok(match caldav_dav::get(transport, href).await? {
            Some(object) => (object.etag, object.data),
            None => (None, sent.to_owned()),
        })
    }

    async fn create(
        &self,
        open: &OpenVault,
        pass: &Pass,
        item: &Item<'_>,
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Outcome, SyncError> {
        let key = item.key();
        let mut pending = self.pending(open).await?;
        if let Some(entry) = pending.get(&key) {
            let href = entry["href"].as_str().unwrap_or_default().to_owned();
            let calendar_id = entry["calendarId"].as_str().unwrap_or_default().to_owned();
            if let Some(object) = caldav_dav::get(transport, &href).await? {
                // The earlier create landed: record it, send nothing.
                let outcome = self
                    .done(pass, item, &calendar_id, &href, object.etag, object.data)
                    .await?;
                pending.remove(&key);
                self.set_pending(open, pending).await?;
                return Ok(outcome);
            }
        }
        let (Some(href), Some(body)) = (plan.href.clone(), plan.body.clone()) else {
            return self.skip(pass, item).await;
        };
        pending.insert(
            key.clone(),
            json!({ "href": href, "calendarId": plan.calendar_id }),
        );
        self.set_pending(open, pending.clone()).await?;
        let etag = match caldav_dav::put(transport, &href, &body, Precondition::Create).await {
            Ok(etag) => etag,
            // Something already sits at a UID this device just minted: its own earlier write.
            Err(DavError::Conflict) => caldav_dav::get(transport, &href)
                .await?
                .and_then(|object| object.etag),
            Err(error) => return Err(error.into()),
        };
        let (etag, data) = Self::written(transport, &href, &body, etag).await?;
        let remote = plan.remote_event_id.clone().unwrap_or_else(|| href.clone());
        let outcome = self
            .done(pass, item, &plan.calendar_id, &remote, etag, data)
            .await?;
        pending.remove(&key);
        self.set_pending(open, pending).await?;
        Ok(outcome)
    }

    async fn update(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        source: &CalendarSourceRecord,
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Outcome, SyncError> {
        let (Some(href), Some(body), Some(if_match)) =
            (plan.href.as_deref(), plan.body.as_deref(), plan.if_match.as_deref())
        else {
            return self.skip(pass, item).await;
        };
        match caldav_dav::put(transport, href, body, Precondition::Match(if_match)).await {
            Ok(etag) => {
                let (etag, data) = Self::written(transport, href, body, etag).await?;
                let remote = plan.remote_event_id.clone().unwrap_or_else(|| href.to_owned());
                self.done(pass, item, &plan.calendar_id, &remote, etag, data).await
            }
            Err(DavError::Conflict) => {
                // The remote changed: it wins, through the pull's write-back.
                let current = caldav_dav::get(transport, href).await?;
                let removed = if current.is_none() { vec![href.to_owned()] } else { Vec::new() };
                let cursor = source.sync_cursor.clone();
                let objects = current.into_iter().collect();
                apply_objects(&pass.calendar, source, objects, removed, false, cursor).await?;
                tracing::info!(scope = SCOPE, "a CalDAV update met a remote change; the remote kept it");
                Ok(Outcome::Pushed)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn delete(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Outcome, SyncError> {
        let (Some(href), Some(binding)) = (plan.href.as_deref(), plan.binding_id.clone()) else {
            return self.skip(pass, item).await;
        };
        match caldav_dav::delete(transport, href, plan.if_match.as_deref()).await {
            Ok(()) => self.deleted(pass, item, binding).await,
            Err(DavError::Conflict) => {
                tracing::info!(
                    scope = SCOPE,
                    "a CalDAV delete met a remote change; the remote object stays"
                );
                self.deleted(pass, item, binding).await
            }
            Err(error) => Err(error.into()),
        }
    }

    /// One occurrence of a series: `PUT` the series without it; a 412 retries once on the
    /// object the server holds now.
    async fn exclude(
        &self,
        pass: &Pass,
        item: &Item<'_>,
        held: &[String],
        plan: &CalendarPushPlan,
        transport: &Transport,
    ) -> Result<Outcome, SyncError> {
        let mut plan = plan.clone();
        for attempt in 0..2 {
            let (Some(href), Some(body), Some(binding)) =
                (plan.href.clone(), plan.body.clone(), plan.binding_id.clone())
            else {
                return self.skip(pass, item).await;
            };
            let if_match = plan.if_match.clone().unwrap_or_else(|| "*".to_owned());
            match caldav_dav::put(transport, &href, &body, Precondition::Match(&if_match)).await {
                Ok(_) => return self.deleted(pass, item, binding).await,
                Err(DavError::Conflict) if attempt == 0 => {
                    let Some(object) = caldav_dav::get(transport, &href).await? else {
                        return self.deleted(pass, item, binding).await;
                    };
                    plan = self.plan(pass, item, held, Some(dav_object(object))).await?;
                    if plan.action != "exclude" {
                        return self.deleted(pass, item, binding).await;
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(DavError::Conflict.into())
    }

    async fn pending(&self, open: &OpenVault) -> Result<Map<String, Value>, SyncError> {
        let settings = open.vault.app_settings(self.store.clone())?;
        Ok(match blocking(move || settings.get_local(PENDING_CREATES_KEY)).await?? {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        })
    }

    async fn set_pending(&self, open: &OpenVault, map: Map<String, Value>) -> Result<(), SyncError> {
        let settings = open.vault.app_settings(self.store.clone())?;
        blocking(move || settings.set_local(PENDING_CREATES_KEY, &Value::Object(map))).await??;
        Ok(())
    }
}

fn dav_object(object: caldav_dav::DavObject) -> CalendarCaldavObject {
    CalendarCaldavObject {
        href: object.href,
        etag: object.etag,
        data: object.data,
    }
}
