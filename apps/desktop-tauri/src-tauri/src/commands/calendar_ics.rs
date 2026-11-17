//! Subscribed calendars (#3546 29d): the commands of `ipc/calendar-ics-handlers.ts`
//! (`subscribe-ics`, `unsubscribe-ics`, `refresh-ics`), each one call of
//! `memry_desktop::calendar_providers::feeds::IcsFeeds`, and the session-owned runner that
//! refreshes the due feeds (`ics/ics-runner.ts`). A feed failure answers the handlers'
//! `success: false` with its `errorCode`; any other failure throws, which the renderer turns into
//! `success: false` as `withDb` did.

use std::sync::Arc;

use memry_desktop::calendar_providers::feeds::{FeedSummary, FeedsError, IcsFeeds, OnChanged};
use memry_desktop::calendar_providers::ics_fetch::{self, IcsFeedCode, IcsFetcher};
use memry_desktop::calendar_providers::runner::{self, CalendarRunner};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::Session;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::open_vault;
use crate::shutdown::ShutdownService;

const SCOPE: &str = "calendar_ics";

/// `SubscribeIcsCalendarSchema`.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IcsSubscribeInput {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// `IcsCalendarSourceRequestSchema`.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IcsSourceInput {
    pub source_id: String,
}

/// `IcsCalendarMutationResponse`, with the source's id where the handlers send the whole row.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IcsMutationView {
    pub success: bool,
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error_code: Option<IcsFeedCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub summary: Option<FeedSummary>,
}

impl IcsMutationView {
    fn done(source_id: String) -> Self {
        Self {
            success: true,
            source_id: Some(source_id),
            error_code: None,
            error: None,
            summary: None,
        }
    }

    fn failed(source_id: Option<String>, code: IcsFeedCode) -> Self {
        Self {
            success: false,
            source_id,
            error_code: Some(code),
            error: Some(code.as_str().to_owned()),
            summary: None,
        }
    }
}

/// Builds the feed service and the runner, hangs the runner on the session (open and
/// `calendar` close hooks) and on the `stop-schedulers` shutdown step. At `VaultOpen`, once the
/// device identity (`Handlers`) and the shutdown service exist.
pub fn register(app: &AppHandle<Wry>, session: &Session) {
    let Some(identity) = app.try_state::<Arc<DeviceIdentityStore>>() else {
        tracing::error!(
            scope = SCOPE,
            "no device identity: calendar feeds do not run"
        );
        return;
    };
    let fetcher = match IcsFetcher::new(memry_desktop::http::builder(), ics_fetch::TIMEOUT) {
        Ok(fetcher) => fetcher,
        Err(error) => {
            tracing::error!(
                scope = SCOPE,
                "the calendar feed client could not be built: {error}"
            );
            return;
        }
    };
    // #4894 (29b) adds `CalendarChangedEvent`; this sink broadcasts it (`calendar_source` and
    // `projection`, as Electron's `emitCalendarChanged`) once that lands on this branch.
    let on_changed: OnChanged = Arc::new(|change| {
        tracing::debug!(scope = SCOPE, ?change, "calendar feed changed");
    });
    let feeds = Arc::new(IcsFeeds::new(fetcher, identity.inner().clone(), on_changed));
    let runner = CalendarRunner::new(
        feeds.clone(),
        tauri::async_runtime::handle().inner().clone(),
        runner::TICK,
    );
    runner.register(session);
    if let Err(error) = app
        .state::<ShutdownService>()
        .register("stop-schedulers", runner.shutdown_step())
    {
        tracing::error!(
            scope = SCOPE,
            "the calendar runner has no shutdown step: {error}"
        );
    }
    app.manage(feeds);
    app.manage(runner);
}

fn feeds(app: &AppHandle<Wry>) -> Result<Arc<IcsFeeds>, CommandError> {
    app.try_state::<Arc<IcsFeeds>>()
        .map(|feeds| feeds.inner().clone())
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::Internal,
                "calendar_feeds_unavailable",
                "calendar feeds are not running this session",
            )
        })
}

fn thrown(command: &str, error: &FeedsError) -> CommandError {
    let error = CommandError::from_core(error);
    log_failure(command, &error);
    error
}

/// `calendar:subscribe-ics`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_subscribe_ics(
    app: AppHandle<Wry>,
    input: IcsSubscribeInput,
) -> Result<IcsMutationView, CommandError> {
    let open = open_vault(&app)?;
    match feeds(&app)?
        .subscribe(&open, &input.url, input.title.as_deref())
        .await
    {
        Ok(subscribed) => Ok(IcsMutationView {
            summary: Some(subscribed.summary),
            ..IcsMutationView::done(subscribed.source_id)
        }),
        Err(FeedsError::Feed(code)) => {
            tracing::warn!(
                scope = SCOPE,
                code = code.as_str(),
                "calendar feed subscribe failed"
            );
            Ok(IcsMutationView::failed(None, code))
        }
        Err(error) => Err(thrown("calendar_subscribe_ics", &error)),
    }
}

/// `calendar:unsubscribe-ics`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_unsubscribe_ics(
    app: AppHandle<Wry>,
    input: IcsSourceInput,
) -> Result<IcsMutationView, CommandError> {
    let open = open_vault(&app)?;
    feeds(&app)?
        .unsubscribe(&open, &input.source_id)
        .await
        .map_err(|error| thrown("calendar_unsubscribe_ics", &error))?;
    Ok(IcsMutationView::done(input.source_id))
}

/// `calendar:refresh-ics`: a feed failure is already recorded on the source, which shows it.
#[tauri::command]
#[specta::specta]
pub async fn calendar_refresh_ics(
    app: AppHandle<Wry>,
    input: IcsSourceInput,
) -> Result<IcsMutationView, CommandError> {
    let open = open_vault(&app)?;
    match feeds(&app)?.refresh(&open, &input.source_id).await {
        Ok(()) => Ok(IcsMutationView::done(input.source_id)),
        Err(FeedsError::Feed(code)) => Ok(IcsMutationView::failed(Some(input.source_id), code)),
        Err(error) => Err(thrown("calendar_refresh_ics", &error)),
    }
}
