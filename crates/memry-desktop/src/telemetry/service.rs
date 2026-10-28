//! The telemetry client: one queue, one crash-durable journal, one sender.
//!
//! Behavior of `client.ts` and `runtime.ts`: events queue only while telemetry is enabled, at
//! most 500 are kept (oldest dropped), a flush ships 50 in one batch, a 4xx other than 429
//! drops the batch and anything else keeps it, and turning telemetry off empties the queue and
//! removes the mirror.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use memry_core::seams::transport::{HttpRequest, Transport};
use serde::Serialize;

use super::config::TelemetryConfig;
use super::events::{TelemetryEvent, sanitize_dimensions, sanitize_failure};
use super::ship_queue::ShipQueue;
use super::time::{iso, now_ms};

pub const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const EVENT_QUEUE_FILE: &str = "telemetry-event-queue.json";

/// What is true of this launch, sent with every batch.
#[derive(Debug, Clone)]
pub struct Context {
    pub install_id: String,
    pub session_id: String,
    pub app_version: String,
    /// `development`, `staging` or `production`.
    pub build_channel: String,
    /// `darwin`, `win32` or `linux`.
    pub platform: String,
    pub arch: String,
    pub locale: String,
    pub timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushResult {
    pub success: bool,
    pub attempted: usize,
    pub accepted: usize,
    pub error: Option<String>,
}

impl FlushResult {
    pub(super) fn failed(attempted: usize, error: String) -> Self {
        Self {
            success: false,
            attempted,
            accepted: 0,
            error: Some(error),
        }
    }

    pub(super) fn idle() -> Self {
        Self {
            success: true,
            attempted: 0,
            accepted: 0,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushReason {
    Manual,
    Interval,
    Shutdown,
    Background,
}

/// Where a batch goes: the sync server, through the pinned transport (`seams::transport`), with a
/// ten second request timeout.
#[derive(Clone)]
pub struct Sender {
    endpoint: String,
    transport: Arc<dyn Transport>,
}

impl Sender {
    pub fn new(endpoint: impl Into<String>, transport: Arc<dyn Transport>) -> Self {
        Self {
            endpoint: endpoint.into(),
            transport,
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// POSTs `body` as JSON and returns the status code.
    pub async fn post(&self, body: String) -> Result<u16, String> {
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: self.endpoint.clone(),
            headers: HashMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            body: Some(body.into_bytes()),
            timeout_ms: u64::try_from(REQUEST_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
        };
        self.transport
            .send(request)
            .await
            .map(|response| response.status)
            .map_err(|error| error.to_string())
    }
}

/// Mutable context of a batch: it changes while the app runs.
struct Live {
    auth_state: &'static str,
    sync_state: &'static str,
    locale: String,
}

pub struct Service {
    pub(super) salt: String,
    pub(super) vault_root: Mutex<Option<String>>,
    config: TelemetryConfig,
    context: Context,
    queue: ShipQueue<TelemetryEvent>,
    live: Mutex<Live>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Batch<'a> {
    schema_version: u8,
    install_id: &'a str,
    session_id: &'a str,
    app_version: &'a str,
    build_channel: &'a str,
    platform: &'a str,
    arch: &'a str,
    locale: &'a str,
    timezone_offset_minutes: i32,
    auth_state: &'a str,
    sync_state: &'a str,
    client_queue_depth: usize,
    events: &'a [TelemetryEvent],
}

impl Service {
    /// Restores what the previous process left in the journal (only when enabled; a disabled
    /// install removes it).
    pub fn start(data_dir: &Path, context: Context, sender: Sender, enabled: bool) -> Self {
        let config = TelemetryConfig::new(data_dir);
        let locale = context.locale.clone();
        Self {
            salt: config.diagnostics_salt(),
            vault_root: Mutex::new(None),
            config,
            context,
            queue: ShipQueue::restore(data_dir.join(EVENT_QUEUE_FILE), sender, enabled),
            live: Mutex::new(Live {
                auth_state: "anonymous",
                sync_state: "unknown",
                locale,
            }),
        }
    }

    fn live(&self) -> std::sync::MutexGuard<'_, Live> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn config(&self) -> &TelemetryConfig {
        &self.config
    }

    pub fn context(&self) -> &Context {
        &self.context
    }

    pub fn enabled(&self) -> bool {
        self.queue.is_enabled()
    }

    /// A copy of the queue, oldest first.
    pub fn queued(&self) -> Vec<TelemetryEvent> {
        self.queue.items()
    }

    /// The open vault's root, collapsed to `<vault>` in reported text.
    pub fn set_vault_root(&self, root: Option<String>) {
        *self
            .vault_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = root;
    }

    pub fn queue_depth(&self) -> usize {
        self.queue.depth()
    }

    pub fn locale(&self) -> String {
        self.live().locale.clone()
    }

    pub fn set_locale(&self, locale: &str) {
        self.live().locale = locale.to_owned();
    }

    pub fn auth_state(&self) -> &'static str {
        self.live().auth_state
    }

    pub fn set_auth_state(&self, state: &'static str) {
        self.live().auth_state = state;
    }

    pub fn sync_state(&self) -> &'static str {
        self.live().sync_state
    }

    pub fn set_sync_state(&self, state: &'static str) {
        self.live().sync_state = state;
    }

    /// Queues `event` when telemetry is on and the event is a known one. Dimensions and failure
    /// detail are sanitized here, because the server rejects a whole batch for one bad event.
    pub fn track(&self, mut event: TelemetryEvent) {
        if !event.is_known() {
            tracing::warn!(
                scope = "Telemetry",
                "dropping a telemetry event with an unknown name, surface or result"
            );
            return;
        }
        event.dimensions = sanitize_dimensions(event.dimensions.as_ref());
        event.failure = sanitize_failure(event.failure.as_ref());
        self.queue.push(event);
    }

    /// Switches telemetry on or off and stores the choice. Off empties the queue and the mirror.
    pub fn set_enabled(&self, enabled: bool) {
        self.config.set_enabled(enabled);
        self.queue.set_enabled(enabled);
    }

    /// An event with a fresh id and timestamp, the common shape of every main-process event.
    pub fn event(name: &str, surface: &str, action: &str) -> TelemetryEvent {
        TelemetryEvent {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_owned(),
            occurred_at: iso(now_ms()),
            surface: surface.to_owned(),
            action: action.to_owned(),
            object_type: None,
            source: None,
            result: None,
            error_code: None,
            dimensions: None,
            metrics: None,
            error: None,
            failure: None,
        }
    }

    /// Ships one batch.
    pub async fn flush(&self, reason: FlushReason) -> FlushResult {
        let (locale, auth_state, sync_state) = {
            let live = self.live();
            (live.locale.clone(), live.auth_state, live.sync_state)
        };
        self.queue
            .flush(reason, |events, depth| {
                serde_json::to_string(&Batch {
                    schema_version: 1,
                    install_id: &self.context.install_id,
                    session_id: &self.context.session_id,
                    app_version: &self.context.app_version,
                    build_channel: &self.context.build_channel,
                    platform: &self.context.platform,
                    arch: &self.context.arch,
                    locale: &locale,
                    timezone_offset_minutes: self.context.timezone_offset_minutes,
                    auth_state,
                    sync_state,
                    client_queue_depth: depth,
                    events,
                })
            })
            .await
    }
}
