//! The telemetry client: one queue, one crash-durable journal, one sender.
//!
//! Behavior of `client.ts` and `runtime.ts`: events queue only while telemetry is enabled, at
//! most 500 are kept (oldest dropped), a flush ships 50 in one batch, a 4xx other than 429
//! drops the batch and anything else keeps it, and turning telemetry off empties the queue and
//! removes the mirror.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;

use super::config::TelemetryConfig;
use super::events::{TelemetryEvent, sanitize_dimensions, sanitize_failure};
use super::journal::Journal;
use super::time::{iso, now_ms};
use crate::launch_env::LaunchEnv;

pub const QUEUE_LIMIT: usize = 500;
pub const BATCH_LIMIT: usize = 50;
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const EVENT_QUEUE_FILE: &str = "telemetry-event-queue.json";
const PRODUCTION_ENDPOINT: &str = "https://sync.memrynote.com/telemetry/batch";

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
    fn idle() -> Self {
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

/// Where a batch goes. The one HTTP client of the app, a ten second request timeout.
#[derive(Clone)]
pub struct Sender {
    endpoint: String,
}

impl Sender {
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// POSTs `body` as JSON and returns the status code.
    pub async fn post(&self, body: String) -> Result<u16, String> {
        crate::http::client()
            .post(&self.endpoint)
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map(|response| response.status().as_u16())
            .map_err(|error| error.to_string())
    }
}

/// `explicit override`, `TELEMETRY_ENDPOINT`, `SYNC_SERVER_URL` + `/telemetry/batch`, then the
/// production default (`runtime.ts`).
pub fn resolve_endpoint(explicit: Option<&str>, env: &LaunchEnv) -> String {
    let non_empty = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
    non_empty(explicit)
        .or_else(|| non_empty(env.get("TELEMETRY_ENDPOINT")))
        .or_else(|| {
            non_empty(env.get("SYNC_SERVER_URL"))
                .map(|url| format!("{}/telemetry/batch", url.trim_end_matches('/')))
        })
        .unwrap_or_else(|| PRODUCTION_ENDPOINT.to_owned())
}

/// Enabled when the stored flag says so; else `MEMRY_TELEMETRY_ENABLED=true`; else on only for
/// the production channel.
pub fn resolve_enabled(stored: Option<bool>, env: &LaunchEnv, build_channel: &str) -> bool {
    stored.unwrap_or_else(|| {
        env.get("MEMRY_TELEMETRY_ENABLED") == Some("true") || build_channel == "production"
    })
}

struct State {
    enabled: bool,
    queue: Vec<TelemetryEvent>,
    journal: Journal,
    auth_state: &'static str,
    sync_state: &'static str,
    locale: String,
}

pub struct Service {
    pub(super) salt: String,
    pub(super) vault_root: Mutex<Option<String>>,
    config: TelemetryConfig,
    context: Context,
    sender: Sender,
    state: Mutex<State>,
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
        let mut journal = Journal::new(data_dir.join(EVENT_QUEUE_FILE));
        let mut queue = Vec::new();
        if enabled {
            queue = journal.load::<TelemetryEvent>();
            if queue.len() > QUEUE_LIMIT {
                queue.drain(..queue.len() - QUEUE_LIMIT);
                journal.save(&queue);
            }
        } else {
            journal.clear();
        }
        let locale = context.locale.clone();
        let config = TelemetryConfig::new(data_dir);
        Self {
            salt: config.diagnostics_salt(),
            vault_root: Mutex::new(None),
            config,
            context,
            sender,
            state: Mutex::new(State {
                enabled,
                queue,
                journal,
                auth_state: "anonymous",
                sync_state: "unknown",
                locale,
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn config(&self) -> &TelemetryConfig {
        &self.config
    }

    pub fn context(&self) -> &Context {
        &self.context
    }

    pub fn enabled(&self) -> bool {
        self.state().enabled
    }

    /// A copy of the queue, oldest first.
    pub fn queued(&self) -> Vec<TelemetryEvent> {
        self.state().queue.clone()
    }

    /// The open vault's root, collapsed to `<vault>` in reported text.
    pub fn set_vault_root(&self, root: Option<String>) {
        *self
            .vault_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = root;
    }

    pub fn queue_depth(&self) -> usize {
        self.state().queue.len()
    }

    pub fn set_locale(&self, locale: &str) {
        self.state().locale = locale.to_owned();
    }

    pub fn set_auth_state(&self, state: &'static str) {
        self.state().auth_state = state;
    }

    pub fn set_sync_state(&self, state: &'static str) {
        self.state().sync_state = state;
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
        let mut state = self.state();
        if !state.enabled {
            return;
        }
        state.queue.push(event.clone());
        let over = state.queue.len().saturating_sub(QUEUE_LIMIT);
        if over > 0 {
            state.queue.drain(..over);
        }
        let State { journal, queue, .. } = &mut *state;
        journal.append(&event, queue);
    }

    /// Switches telemetry on or off and stores the choice. Off empties the queue and the mirror.
    pub fn set_enabled(&self, enabled: bool) {
        self.config.set_enabled(enabled);
        let mut state = self.state();
        state.enabled = enabled;
        if !enabled {
            state.queue.clear();
            state.journal.clear();
        }
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

    /// Ships one batch. The lock is not held across the request.
    pub async fn flush(&self, reason: FlushReason) -> FlushResult {
        let (body, size) = {
            let state = self.state();
            if !state.enabled || state.queue.is_empty() {
                return FlushResult::idle();
            }
            let size = state.queue.len().min(BATCH_LIMIT);
            let batch = Batch {
                schema_version: 1,
                install_id: &self.context.install_id,
                session_id: &self.context.session_id,
                app_version: &self.context.app_version,
                build_channel: &self.context.build_channel,
                platform: &self.context.platform,
                arch: &self.context.arch,
                locale: &state.locale,
                timezone_offset_minutes: self.context.timezone_offset_minutes,
                auth_state: state.auth_state,
                sync_state: state.sync_state,
                client_queue_depth: state.queue.len(),
                events: &state.queue[..size],
            };
            match serde_json::to_string(&batch) {
                Ok(body) => (body, size),
                Err(error) => {
                    return FlushResult {
                        success: false,
                        attempted: size,
                        accepted: 0,
                        error: Some(error.to_string()),
                    };
                }
            }
        };

        match self.sender.post(body).await {
            Ok(status) if (200..300).contains(&status) => {
                self.drop_front(size);
                tracing::info!(
                    scope = "Telemetry",
                    "telemetry batch accepted: {size} events (HTTP {status})"
                );
                FlushResult {
                    success: true,
                    attempted: size,
                    accepted: size,
                    error: None,
                }
            }
            Ok(status) => {
                let permanent = (400..500).contains(&status) && status != 429;
                if permanent {
                    self.drop_front(size);
                }
                tracing::warn!(
                    scope = "Telemetry",
                    "telemetry batch rejected: status={status} reason={reason:?} dropped={permanent}"
                );
                FlushResult {
                    success: false,
                    attempted: size,
                    accepted: 0,
                    error: Some(format!("HTTP {status}")),
                }
            }
            Err(error) => {
                tracing::warn!(
                    scope = "Telemetry",
                    "telemetry flush failed: reason={reason:?} {error}"
                );
                FlushResult {
                    success: false,
                    attempted: size,
                    accepted: 0,
                    error: Some(error),
                }
            }
        }
    }

    fn drop_front(&self, count: usize) {
        let mut state = self.state();
        let count = count.min(state.queue.len());
        state.queue.drain(..count);
        let State { journal, queue, .. } = &mut *state;
        journal.save(queue);
    }
}
