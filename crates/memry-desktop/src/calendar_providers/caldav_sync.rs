//! The CalDAV pull (`caldav/caldav-sync.ts`): one pass over every account this device holds a
//! password for, each selected calendar pulled in full the first time (the window's objects),
//! then from its RFC 6578 sync token, or from its ctag on a server without `sync-collection`.
//! The core applies each answer (`VaultCalendar::caldav_apply_pull`): mirror rows, objects a
//! Memry item is bound to flowing back into the item, the cursor on the synced source row.
//!
//! A rejected password marks the account in this device's `calendar.caldav.authFailures` local
//! setting (`caldav-accounts.ts:118-148`, the same key and JSON); a later pull that succeeds
//! clears it. The push drain is [`super::caldav_push`].

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::calendar::VaultCalendar;
use memry_core::api::calendar_provider_sync::CalendarCaldavObject;
use memry_core::api::calendar_records::CalendarSourceRecord;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::calendar_items::ics;
use memry_core::domain::calendar_items::providers::CALDAV;
use memry_core::seams::secure_store::SecureStore;
use serde_json::{Map, Value};
use url::Url;

use super::caldav_dav::{self, DavError, DavObject};
use super::caldav_push::DrainSummary;
use super::caldav_transport::{CaldavHttp, Transport};
use super::credentials::{CredentialError, ProviderCredentials, SecretKind};
use super::zones::feed_zones;
use crate::error::{CoreError, FailureKind};
use crate::session::OpenVault;

const SCOPE: &str = "calendar_caldav_sync";
/// `AUTH_FAILURES_KEY`: this device only, as Electron's settings table.
pub const AUTH_FAILURES_KEY: &str = "calendar.caldav.authFailures";

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Dav(#[from] DavError),
    /// `CalDAV calendar not found` / `CalDAV account not found`.
    #[error("{0}")]
    NotFound(&'static str),
    /// This device holds no password for the account.
    #[error("no app password for this CalDAV account on this device")]
    NoPassword,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Credential(#[from] CredentialError),
    #[error("a calendar task failed: {0}")]
    Task(String),
    /// `syncCaldavNow` came back with this many calendars that did not pull.
    #[error("{0} CalDAV calendars failed to sync")]
    Partial(u32),
}

impl CoreError for SyncError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
            Self::Credential(CredentialError::Store(error)) => error.kind_and_code(),
            Self::Task(_) => (FailureKind::Internal, "task_failed"),
            _ => (FailureKind::Invalid, "sync_failed"),
        }
    }
}

impl SyncError {
    /// The server refused the password (`ProviderAuthError`).
    pub fn is_auth(&self) -> bool {
        matches!(self, Self::Dav(DavError::Auth(_)) | Self::NoPassword)
    }
}

/// `syncCaldavNow`'s answer.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SyncSummary {
    pub synced: u32,
    pub failed: u32,
    pub retry_after_ms: Option<u64>,
}

pub struct CaldavSync {
    pub(super) http: CaldavHttp,
    pub(super) credentials: Arc<ProviderCredentials>,
    pub(super) store: Arc<dyn SecureStore>,
    /// Accounts with a pass under way (`runExclusive`): a second one is skipped.
    running: Mutex<HashSet<String>>,
    /// One push drain at a time.
    pub(super) draining: tokio::sync::Mutex<()>,
}

/// The account row's synced metadata (`readAccountMetadata`).
pub(super) struct AccountMeta {
    pub server_url: String,
    pub username: String,
}

pub(super) fn account_meta(account: &CalendarSourceRecord) -> Option<AccountMeta> {
    let metadata: Value = serde_json::from_str(account.metadata_json.as_deref()?).ok()?;
    let text = |key: &str| {
        metadata[key]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Some(AccountMeta {
        server_url: text("serverUrl")?,
        username: text("username")?,
    })
}

pub(super) fn live(source: &CalendarSourceRecord, kind: &str) -> bool {
    source.provider == CALDAV && source.kind == kind && source.archived_at.is_none()
}

fn supports_sync_collection(source: &CalendarSourceRecord) -> bool {
    let metadata = source
        .metadata_json
        .as_deref()
        .and_then(|m| serde_json::from_str::<Value>(m).ok());
    metadata.is_none_or(|m| m["supportsSyncCollection"] != Value::Bool(false))
}

enum Cursor {
    Token(String),
    Ctag(String),
}

fn parse_cursor(value: Option<&str>) -> Option<Cursor> {
    let value = value?;
    if let Some(token) = value.strip_prefix("sync-token:") {
        return Some(Cursor::Token(token.to_owned()));
    }
    value
        .strip_prefix("ctag:")
        .map(|ctag| Cursor::Ctag(ctag.to_owned()))
}

/// One pull's answer, before the core applies it.
struct Pulled {
    objects: Vec<DavObject>,
    removed: Vec<String>,
    full: bool,
    cursor: Option<String>,
}

pub(super) fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, SyncError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| SyncError::Task(error.to_string()))
}

impl CaldavSync {
    pub fn new(
        http: CaldavHttp,
        credentials: Arc<ProviderCredentials>,
        store: Arc<dyn SecureStore>,
    ) -> Self {
        Self {
            http,
            credentials,
            store,
            running: Mutex::new(HashSet::new()),
            draining: tokio::sync::Mutex::new(()),
        }
    }

    pub(super) async fn calendar(&self, open: &OpenVault) -> Result<Arc<VaultCalendar>, SyncError> {
        let store = self.store.clone();
        blocking(move || ensure_device_identity(store)).await??;
        Ok(open.vault.calendar(self.store.clone())?)
    }

    /// The accounts the server rejected the password of, on this device.
    pub async fn auth_failures(&self, open: &OpenVault) -> Result<Map<String, Value>, SyncError> {
        let settings = open.vault.app_settings(self.store.clone())?;
        let value = blocking(move || settings.get_local(AUTH_FAILURES_KEY)).await??;
        Ok(match value {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        })
    }

    /// `setCaldavAuthFailure`: writes only when the mark changes.
    async fn set_auth_failure(
        &self,
        open: &OpenVault,
        account: &str,
        failed: bool,
    ) -> Result<(), SyncError> {
        let mut current = self.auth_failures(open).await?;
        if (current.get(account) == Some(&Value::Bool(true))) == failed {
            return Ok(());
        }
        if failed {
            current.insert(account.to_owned(), Value::Bool(true));
        } else {
            current.remove(account);
        }
        let settings = open.vault.app_settings(self.store.clone())?;
        blocking(move || settings.set_local(AUTH_FAILURES_KEY, &Value::Object(current))).await??;
        Ok(())
    }

    /// `transportForAccount`: `None` when this device has no password for it.
    pub(super) async fn transport(
        &self,
        account: &CalendarSourceRecord,
    ) -> Result<Option<Transport>, SyncError> {
        let (Some(meta), Some(id)) = (account_meta(account), account.account_id.clone()) else {
            return Ok(None);
        };
        let Ok(server) = Url::parse(&meta.server_url) else {
            return Ok(None);
        };
        let credentials = self.credentials.clone();
        let password =
            blocking(move || credentials.get(CALDAV, &id, SecretKind::Password)).await??;
        Ok(password.map(|p| self.http.transport(&server, &meta.username, p.as_str())))
    }

    /// The push drain, then every account's pull (or one's). Draining first sends local edits
    /// before the pull sees the remote; a pull skips items still queued either way. A calendar
    /// that failed to pull fails the pass; an item the drain could not write stays queued with its
    /// reason. A calendar the drain flagged (`DrainSummary::attention`) is marked `error` after
    /// its pull, which would otherwise mark it `ok`.
    pub async fn sync_and_drain(
        &self,
        open: &OpenVault,
        account_id: Option<&str>,
    ) -> Result<(), SyncError> {
        let drained = self.drain(open).await?;
        let summary = self.sync_now(open, account_id).await;
        self.flag(open, drained).await?;
        match summary?.failed {
            0 => Ok(()),
            failed => Err(SyncError::Partial(failed)),
        }
    }

    /// One calendar's Retry (`calendar_refresh_provider` with a `sourceId`): the push drain, then
    /// that calendar's pull, flagged the same way, so a queued edit is sent rather than stranded.
    pub async fn sync_source_and_drain(
        &self,
        open: &OpenVault,
        source_id: &str,
    ) -> Result<(), SyncError> {
        let drained = self.drain(open).await?;
        let pulled = self.sync_source(open, source_id).await;
        self.flag(open, drained).await?;
        pulled.map(|_| ())
    }

    async fn flag(&self, open: &OpenVault, drained: DrainSummary) -> Result<(), SyncError> {
        for id in drained.attention {
            let writer = self.calendar(open).await?;
            blocking(move || {
                writer.provider_source_error(id, "a CalDAV write was not applied".to_owned())
            })
            .await??;
        }
        if drained.failed > 0 || drained.waiting > 0 {
            tracing::info!(
                scope = SCOPE,
                failed = drained.failed,
                waiting = drained.waiting,
                "CalDAV writes left queued"
            );
        }
        Ok(())
    }

    /// `syncCaldavCalendarSource`: pulls one calendar. A stale sync token pulls in full; a
    /// rejected password marks the account, a pull that lands clears the mark.
    pub async fn sync_source(&self, open: &OpenVault, source_id: &str) -> Result<u32, SyncError> {
        let calendar = self.calendar(open).await?;
        let reader = calendar.clone();
        let sources = blocking(move || reader.sources()).await??;
        let source = sources
            .iter()
            .find(|s| s.id == source_id && s.provider == CALDAV && s.kind == "calendar")
            .ok_or(SyncError::NotFound("CalDAV calendar not found"))?;
        let account = sources
            .iter()
            .find(|a| {
                live(a, "account") && a.account_id.is_some() && a.account_id == source.account_id
            })
            .ok_or(SyncError::NotFound("CalDAV account not found"))?;
        let account_id = account.account_id.clone().unwrap_or_default();
        let transport = self
            .transport(account)
            .await?
            .ok_or(SyncError::NoPassword)?;
        let pulled = match self.pull(source, &transport).await {
            Err(DavError::TokenGone) => self.pull_full(source, &transport).await,
            other => other,
        };
        let outcome = match pulled {
            Ok(pulled) => {
                self.apply_pulled(&calendar, source, &transport, pulled)
                    .await
            }
            Err(error) => Err(SyncError::from(error)),
        };
        match &outcome {
            Ok(_) => self.set_auth_failure(open, &account_id, false).await?,
            Err(error) => {
                if error.is_auth() {
                    self.set_auth_failure(open, &account_id, true).await?;
                }
                let (writer, id, text) = (calendar.clone(), source.id.clone(), error.to_string());
                if let Err(error) = blocking(move || writer.provider_source_error(id, text)).await?
                {
                    tracing::warn!(
                        scope = SCOPE,
                        "could not record a CalDAV pull failure: {error}"
                    );
                }
            }
        }
        outcome
    }

    /// A full listing (`pullFull`, a moved ctag) then the bound check: bound objects have no
    /// mirror rows, and one moved out of the window or deleted is not in the window query. Each
    /// unseen one is checked against the collection's ETags (`listObjectEtags`): a gone one is
    /// removed, a changed one fetched, so its item follows the server.
    async fn apply_pulled(
        &self,
        calendar: &Arc<VaultCalendar>,
        source: &CalendarSourceRecord,
        transport: &Transport,
        mut pulled: Pulled,
    ) -> Result<u32, SyncError> {
        if pulled.full {
            let (reader, url) = (calendar.clone(), source.remote_id.clone());
            let unseen: Vec<_> = blocking(move || reader.caldav_bound_objects(url))
                .await??
                .into_iter()
                .filter(|b| !pulled.objects.iter().any(|o| o.href == b.href))
                .collect();
            if !unseen.is_empty() {
                let collection =
                    Url::parse(&source.remote_id).map_err(|e| DavError::Failed(e.to_string()))?;
                let listed = caldav_dav::list_etags(transport, &collection).await?;
                let mut changed = Vec::new();
                for bound in unseen {
                    match listed.iter().find(|(href, _)| *href == bound.href) {
                        None => pulled.removed.push(bound.href),
                        Some((_, etag)) if *etag != bound.etag => changed.push(bound.href),
                        Some(_) => {}
                    }
                }
                let fetched = caldav_dav::multiget(transport, &collection, &changed).await?;
                pulled.objects.extend(fetched);
            }
        }
        apply_objects(
            calendar,
            source,
            pulled.objects,
            pulled.removed,
            pulled.full,
            pulled.cursor,
        )
        .await
    }

    async fn pull(
        &self,
        source: &CalendarSourceRecord,
        transport: &Transport,
    ) -> Result<Pulled, DavError> {
        let collection =
            Url::parse(&source.remote_id).map_err(|e| DavError::Failed(e.to_string()))?;
        match parse_cursor(source.sync_cursor.as_deref()) {
            None => self.pull_full(source, transport).await,
            Some(Cursor::Token(token)) => {
                let changes = caldav_dav::sync_collection(transport, &collection, &token).await?;
                let objects =
                    caldav_dav::multiget(transport, &collection, &changes.changed).await?;
                Ok(Pulled {
                    objects,
                    removed: changes.deleted,
                    full: false,
                    cursor: changes
                        .token
                        .map(|t| format!("sync-token:{t}"))
                        .or_else(|| source.sync_cursor.clone()),
                })
            }
            Some(Cursor::Ctag(ctag)) => {
                let current = caldav_dav::collection_tag(transport, &collection).await?;
                if current.as_deref() == Some(ctag.as_str()) {
                    return Ok(Pulled {
                        objects: Vec::new(),
                        removed: Vec::new(),
                        full: false,
                        cursor: source.sync_cursor.clone(),
                    });
                }
                let window = ics::window(now_ms());
                let objects = caldav_dav::query_window(
                    transport,
                    &collection,
                    window.start_ms,
                    window.end_ms,
                )
                .await?;
                Ok(Pulled {
                    objects,
                    removed: Vec::new(),
                    full: true,
                    cursor: current.map(|c| format!("ctag:{c}")),
                })
            }
        }
    }

    /// `pullFull`: the cursor first, so a change landing in between is reported again.
    async fn pull_full(
        &self,
        source: &CalendarSourceRecord,
        transport: &Transport,
    ) -> Result<Pulled, DavError> {
        let collection =
            Url::parse(&source.remote_id).map_err(|e| DavError::Failed(e.to_string()))?;
        let cursor = if supports_sync_collection(source) {
            caldav_dav::sync_collection(transport, &collection, "")
                .await?
                .token
                .map(|t| format!("sync-token:{t}"))
        } else {
            caldav_dav::collection_tag(transport, &collection)
                .await?
                .map(|c| format!("ctag:{c}"))
        };
        let window = ics::window(now_ms());
        let objects =
            caldav_dav::query_window(transport, &collection, window.start_ms, window.end_ms)
                .await?;
        Ok(Pulled {
            objects,
            removed: Vec::new(),
            full: true,
            cursor,
        })
    }

    /// `syncCaldavNow`: every account (or one) this device holds a password for, each in its
    /// own exclusive slot; an account already syncing is skipped. A rate limit or a rejected
    /// password stops that account's pass.
    pub async fn sync_now(
        &self,
        open: &OpenVault,
        account_id: Option<&str>,
    ) -> Result<SyncSummary, SyncError> {
        let calendar = self.calendar(open).await?;
        let sources = blocking(move || calendar.sources()).await??;
        let mut summary = SyncSummary::default();
        let accounts = sources.iter().filter(|a| {
            live(a, "account")
                && account_meta(a).is_some()
                && a.account_id
                    .as_deref()
                    .is_some_and(|id| account_id.is_none_or(|wanted| wanted == id))
        });
        for account in accounts {
            let id = account.account_id.clone().unwrap_or_default();
            // Another device's account: its mirror arrives through sync.
            if self.transport(account).await?.is_none() {
                continue;
            }
            if !self
                .running
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id.clone())
            {
                continue;
            }
            let calendars = sources.iter().filter(|s| {
                live(s, "calendar") && s.is_selected && s.account_id.as_deref() == Some(&id)
            });
            for source in calendars {
                match self.sync_source(open, &source.id).await {
                    Ok(_) => summary.synced += 1,
                    Err(error) => {
                        summary.failed += 1;
                        tracing::warn!(scope = SCOPE, source = %source.id, "CalDAV calendar sync failed: {error}");
                        if let SyncError::Dav(DavError::RateLimited(ms)) = error {
                            summary.retry_after_ms =
                                Some(summary.retry_after_ms.unwrap_or(0).max(ms));
                            break;
                        }
                        if error.is_auth() {
                            break;
                        }
                    }
                }
            }
            self.running
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
        }
        Ok(summary)
    }
}

/// The core takes the answer: mirror rows, bound items, the cursor.
pub(super) async fn apply_objects(
    calendar: &Arc<VaultCalendar>,
    source: &CalendarSourceRecord,
    objects: Vec<DavObject>,
    removed: Vec<String>,
    full: bool,
    cursor: Option<String>,
) -> Result<u32, SyncError> {
    let text: String = objects
        .iter()
        .map(|o| o.data.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let zones = feed_zones(&text, now_ms());
    let objects = objects
        .into_iter()
        .map(|o| CalendarCaldavObject {
            href: o.href,
            etag: o.etag,
            data: o.data,
        })
        .collect();
    let (writer, id, url) = (
        calendar.clone(),
        source.id.clone(),
        source.remote_id.clone(),
    );
    Ok(
        blocking(move || writer.caldav_apply_pull(id, url, objects, removed, full, cursor, zones))
            .await??,
    )
}
