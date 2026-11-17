//! Subscribed calendars over the open vault (`ics/ics-subscriptions.ts`, `ipc/calendar-ics-
//! handlers.ts`): subscribe, unsubscribe, refresh one feed now, and the runner's pass over the
//! due ones. The fetch is [`IcsFetcher`]; parsing, the mirror and the per-device fetch state are
//! the core's (`VaultCalendar::feed_*`), and every core call runs on a blocking thread.

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::calendar::VaultCalendar;
use memry_core::api::calendar_providers::{CalendarFeedDue, CalendarFeedState};
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::calendar_items::ics;
use memry_core::seams::secure_store::SecureStore;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::ics_fetch::{Fetched, IcsFeedCode, IcsFetcher};
use super::zones::feed_zones;
use crate::error::{CoreError, FailureKind};
use crate::session::OpenVault;

/// `SubscribeIcsCalendarSchema`: `url` 1 to 4096, `title` at most 200 (UTF-16 units, trimmed).
const MAX_URL: usize = 4096;
const MAX_TITLE: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum FeedsError {
    /// The handlers' `success: false` with an `errorCode`.
    #[error("{0}")]
    Feed(IcsFeedCode),
    #[error("subscribed calendar not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("a calendar task failed: {0}")]
    Task(String),
}

impl CoreError for FeedsError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Feed(code) => (FailureKind::Invalid, code.as_str()),
            Self::NotFound(_) => (FailureKind::NotFound, "calendar_not_found"),
            Self::Invalid(_) => (FailureKind::Invalid, "invalid"),
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
            Self::Task(_) => (FailureKind::Internal, "task_failed"),
        }
    }
}

/// `IcsCalendarFeedSummary`: what this device mirrored from a feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedSummary {
    pub event_count: i64,
    pub first_start_at: Option<String>,
    pub last_start_at: Option<String>,
}

impl From<CalendarFeedState> for FeedSummary {
    fn from(state: CalendarFeedState) -> Self {
        Self {
            event_count: state.event_count,
            first_start_at: state.first_start_at,
            last_start_at: state.last_start_at,
        }
    }
}

/// What a feed operation changed, at the points Electron emits: `calendar_source` from
/// `recordFetchOutcome` and the subscribe and unsubscribe paths
/// (`emitCalendarChanged({ entityType: 'calendar_source', id })`), and the projection when the
/// mirror changed (`emitCalendarProjectionChanged('ics:<id>')`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedChange {
    Source(String),
    Projection(String),
}

pub type OnChanged = Arc<dyn Fn(FeedChange) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscribed {
    pub source_id: String,
    pub summary: FeedSummary,
}

pub struct IcsFeeds {
    fetcher: IcsFetcher,
    /// The device identity: the source row's clock entry is this device's.
    store: Arc<dyn SecureStore>,
    on_changed: OnChanged,
}

impl IcsFeeds {
    pub fn new(fetcher: IcsFetcher, store: Arc<dyn SecureStore>, on_changed: OnChanged) -> Self {
        Self {
            fetcher,
            store,
            on_changed,
        }
    }

    fn changed(&self, source_id: &str, projection: bool) {
        if projection {
            (self.on_changed)(FeedChange::Projection(source_id.to_owned()));
        }
        (self.on_changed)(FeedChange::Source(source_id.to_owned()));
    }

    fn calendar(&self, open: &OpenVault) -> Result<Arc<VaultCalendar>, FeedsError> {
        Ok(open.vault.calendar(self.store.clone())?)
    }

    /// `subscribeIcsCalendar`: a link already subscribed returns that source without a fetch;
    /// otherwise the feed is fetched and parsed before anything is saved, so a wrong link fails
    /// with a reason and leaves nothing behind.
    pub async fn subscribe(
        &self,
        open: &OpenVault,
        url: &str,
        title: Option<&str>,
    ) -> Result<Subscribed, FeedsError> {
        let url = url.trim();
        let title = title.map(str::trim).filter(|t| !t.is_empty());
        if url.is_empty() || utf16_len(url) > MAX_URL {
            return Err(FeedsError::Invalid(format!(
                "the link must be 1 to {MAX_URL} characters"
            )));
        }
        if title.is_some_and(|t| utf16_len(t) > MAX_TITLE) {
            return Err(FeedsError::Invalid(format!(
                "the title is longer than {MAX_TITLE} characters"
            )));
        }
        let normalized =
            ics::normalize_url(url).ok_or(FeedsError::Feed(IcsFeedCode::InvalidUrl))?;
        // Electron subscribes without an account (`accountId: null`): a device that never signed
        // in mints its key here, as its first settings write does; sign-in reuses it.
        let store = self.store.clone();
        blocking(move || ensure_device_identity(store)).await??;
        let calendar = self.calendar(open)?;
        let id = ics::source_id(&normalized);
        if let Some(state) = state_of(&calendar, &id).await? {
            return Ok(Subscribed {
                source_id: id,
                summary: state.into(),
            });
        }
        let feed = match self.fetcher.fetch(&normalized, None, None).await {
            Ok(Fetched::Body(feed)) => feed,
            // A 304 to a request without validators.
            Ok(Fetched::NotModified) => return Err(FeedsError::Feed(IcsFeedCode::HttpError)),
            Err(code) => return Err(FeedsError::Feed(code)),
        };
        let zones = feed_zones(&feed.text, now_ms());
        let title = title.map(str::to_owned);
        let writer = calendar.clone();
        let id = blocking(move || writer.feed_subscribe(normalized, title, feed, zones))
            .await?
            .map_err(refused)?;
        let summary = state_of(&calendar, &id)
            .await?
            .map(FeedSummary::from)
            .ok_or_else(|| FeedsError::NotFound(id.clone()))?;
        self.changed(&id, summary.event_count > 0);
        tracing::info!(
            scope = "calendar_ics",
            source_id = id,
            "subscribed to a calendar feed"
        );
        Ok(Subscribed {
            source_id: id,
            summary,
        })
    }

    /// `unsubscribeIcsCalendar`: the synced tombstone, and this device's mirror dropped.
    pub async fn unsubscribe(&self, open: &OpenVault, source_id: &str) -> Result<(), FeedsError> {
        let calendar = self.calendar(open)?;
        let id = source_id.to_owned();
        let reader = calendar.clone();
        let live = blocking(move || reader.sources())
            .await??
            .into_iter()
            .any(|s| s.id == id && s.provider == ics::PROVIDER);
        if !live {
            return Err(FeedsError::NotFound(source_id.to_owned()));
        }
        let id = source_id.to_owned();
        blocking(move || calendar.feed_unsubscribe(id))
            .await?
            .map_err(refused)?;
        self.changed(source_id, true);
        Ok(())
    }

    /// `refreshIcsCalendarSource`: re-reads one visible feed now. The outcome is recorded on the
    /// source either way; a failure is then returned so the caller can say why.
    pub async fn refresh(&self, open: &OpenVault, source_id: &str) -> Result<(), FeedsError> {
        let calendar = self.calendar(open)?;
        let reader = calendar.clone();
        let due = blocking(move || reader.feeds_due(true))
            .await??
            .into_iter()
            .find(|d| d.source_id == source_id)
            .ok_or_else(|| FeedsError::NotFound(source_id.to_owned()))?;
        self.refresh_one(&calendar, due, &CancellationToken::new())
            .await
    }

    /// `refreshDueIcsCalendars`: removed or hidden feeds lose their mirror (in `feeds_due`), the
    /// visible ones whose refresh time passed are fetched. A failed feed is logged and the pass
    /// goes on. `cancel` ends the pass before the next fetch, or drops one in flight; a write
    /// that started always finishes.
    pub async fn refresh_due(
        &self,
        open: &OpenVault,
        cancel: &CancellationToken,
    ) -> Result<(), FeedsError> {
        let calendar = self.calendar(open)?;
        let reader = calendar.clone();
        let due = blocking(move || reader.feeds_due(false)).await??;
        for feed in due {
            if cancel.is_cancelled() {
                break;
            }
            let source_id = feed.source_id.clone();
            match self.refresh_one(&calendar, feed, cancel).await {
                Ok(()) => {}
                Err(FeedsError::Feed(code)) => tracing::warn!(
                    scope = "calendar_ics",
                    source_id,
                    code = code.as_str(),
                    "calendar feed refresh failed"
                ),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    async fn refresh_one(
        &self,
        calendar: &Arc<VaultCalendar>,
        due: CalendarFeedDue,
        cancel: &CancellationToken,
    ) -> Result<(), FeedsError> {
        let fetched = tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            fetched = self.fetcher.fetch(&due.url, due.etag.as_deref(), due.last_modified.as_deref()) => fetched,
        };
        let (calendar, id) = (calendar.clone(), due.source_id.clone());
        let outcome = match fetched {
            Ok(Fetched::NotModified) => blocking(move || calendar.feed_record_not_modified(id))
                .await?
                .map(|()| false)
                .map_err(refused),
            Ok(Fetched::Body(feed)) => {
                let zones = feed_zones(&feed.text, now_ms());
                blocking(move || calendar.feed_record_fetch(id, feed, zones))
                    .await?
                    .map(|changed| changed > 0)
                    .map_err(refused)
            }
            Err(code) => {
                blocking(move || calendar.feed_record_error(id, code.as_str().to_owned()))
                    .await??;
                Err(FeedsError::Feed(code))
            }
        };
        // The outcome is on the source either way, as `recordFetchOutcome` emits it either way;
        // a body that did not parse was recorded by the core too.
        match &outcome {
            Ok(mirror_changed) => self.changed(&due.source_id, *mirror_changed),
            Err(FeedsError::Feed(_)) => self.changed(&due.source_id, false),
            Err(_) => {}
        }
        outcome.map(|_| ())
    }
}

async fn state_of(
    calendar: &Arc<VaultCalendar>,
    source_id: &str,
) -> Result<Option<CalendarFeedState>, FeedsError> {
    let reader = calendar.clone();
    Ok(blocking(move || reader.feed_states())
        .await??
        .into_iter()
        .find(|s| s.source_id == source_id))
}

/// The core's `Invalid { what }` carries a feed code (`not_a_calendar`, `too_large`,
/// `invalid_url`); its `NotFound` is the handlers' not-found.
fn refused(error: StorageError) -> FeedsError {
    match error {
        StorageError::Invalid { what } => match IcsFeedCode::from_code(&what) {
            Some(code) => FeedsError::Feed(code),
            None => FeedsError::Invalid(what),
        },
        StorageError::NotFound { what } => FeedsError::NotFound(what),
        other => FeedsError::Storage(other),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, FeedsError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| FeedsError::Task(error.to_string()))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
