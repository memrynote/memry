//! Log shipping (Path A) and the ring that feeds incident reports (Path B): a `tracing` layer
//! that takes every warn and error record, redacts it, keeps the last 200 lines or five minutes
//! in a ring, and ships the lines in batches to `/telemetry/logs` (`log-ship.ts`).
//!
//! The layer is installed with logging and does nothing until [`install`] gives it a
//! destination. A development build fills the ring but never ships; a disabled telemetry
//! setting ships nothing and keeps no queue.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt::{self, Write as _};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context as LayerContext;

use super::service::{Context, FlushReason, FlushResult, Sender};
use super::ship_queue::ShipQueue;
use super::time::{iso, now_ms};
use crate::redact::{RedactOptions, redact_log_line, salted_hash};

/// The scopes of the pipeline itself: shipping their own failures would loop.
const SKIP_SCOPES: [&str; 3] = ["LogShip", "Telemetry", "TelemetryQueueStore"];
const RING_LIMIT: usize = 200;
const RING_MS: u64 = 5 * 60 * 1000;
const THROTTLE_WINDOW_MS: u64 = 3000;
const THROTTLE_MAX_KEYS: usize = 500;
pub const LOG_QUEUE_FILE: &str = "telemetry-log-queue.json";

/// A redacted field: the schema allows a string, a number or a boolean.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum FieldValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl FieldValue {
    fn from_json(value: Value) -> Self {
        match value {
            Value::Bool(b) => Self::Bool(b),
            Value::Number(n) => Self::Number(n.as_f64().unwrap_or_default()),
            Value::String(s) => Self::Text(s),
            other => Self::Text(other.to_string()),
        }
    }
}

/// One shipped line (`DiagnosticLogLineSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLine {
    pub ts: String,
    pub level: String,
    pub scope: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, FieldValue>>,
    pub origin: String,
    /// Identifies a throttled line to bump its repeat count. Not on the wire.
    #[serde(skip)]
    #[specta(skip)]
    seq: u64,
}

pub struct Deps {
    pub context: Context,
    pub sender: Sender,
    pub salt: String,
    /// `error` raises the floor to errors only; nothing can lower it below warn.
    pub level: Option<String>,
    /// Development builds never ship; the ring still fills.
    pub ships: bool,
    pub enabled: bool,
    pub queue_path: std::path::PathBuf,
}

struct Ring {
    lines: VecDeque<(u64, DiagnosticLine)>,
    throttle: HashMap<String, (u64, u64)>,
    next_seq: u64,
}

pub struct LogShip {
    context: Context,
    salt: String,
    errors_only: bool,
    ships: bool,
    queue: ShipQueue<DiagnosticLine>,
    ring: Mutex<Ring>,
    vault_root: Mutex<Option<String>>,
}

static INSTANCE: OnceLock<Arc<LogShip>> = OnceLock::new();

/// Installs the destination once. A second call returns the first.
pub fn install(deps: Deps) -> Arc<LogShip> {
    INSTANCE
        .get_or_init(|| {
            let queue_enabled = deps.ships && deps.enabled;
            Arc::new(LogShip {
                context: deps.context,
                salt: deps.salt,
                errors_only: deps.level.as_deref() == Some("error"),
                ships: deps.ships,
                queue: ShipQueue::restore(deps.queue_path, deps.sender, queue_enabled),
                ring: Mutex::new(Ring {
                    lines: VecDeque::new(),
                    throttle: HashMap::new(),
                    next_seq: 1,
                }),
                vault_root: Mutex::new(None),
            })
        })
        .clone()
}

pub fn global() -> Option<Arc<LogShip>> {
    INSTANCE.get().cloned()
}

thread_local! {
    static REENTRANT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl LogShip {
    /// The telemetry setting changed. Off purges the queue and its mirror.
    pub fn set_enabled(&self, enabled: bool) {
        self.queue.set_enabled(self.ships && enabled);
    }

    pub fn set_vault_root(&self, root: Option<String>) {
        *self
            .vault_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = root;
    }

    /// The redacted lines of the last five minutes, oldest first.
    pub fn recent_lines(&self) -> Vec<DiagnosticLine> {
        let ring = self.ring.lock().unwrap_or_else(PoisonError::into_inner);
        ring.lines.iter().map(|(_, line)| line.clone()).collect()
    }

    pub fn queue_depth(&self) -> usize {
        self.queue.depth()
    }

    pub async fn flush(&self) -> FlushResult {
        self.queue
            .flush(FlushReason::Interval, |lines, _| {
                serde_json::to_string(&serde_json::json!({
                    "schemaVersion": 1,
                    "installId": self.context.install_id,
                    "sessionId": self.context.session_id,
                    "appVersion": self.context.app_version,
                    "buildChannel": self.context.build_channel,
                    "platform": self.context.platform,
                    "arch": self.context.arch,
                    "lines": lines,
                }))
            })
            .await
    }

    fn handle(&self, level: &Level, scope: &str, message: &str, fields: &Map<String, Value>) {
        let wire_level = if *level == Level::ERROR {
            "error"
        } else {
            "warn"
        };
        let vault_root = self
            .vault_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let hasher = |value: &str| salted_hash(&self.salt, value);
        let opts = RedactOptions {
            vault_root: vault_root.as_deref(),
            hash: Some(&hasher),
        };
        let redacted = redact_log_line(message, fields, &opts);

        let now = now_ms();
        let key = format!("{wire_level}|{scope}|{}", redacted.message);
        let mut ring = self.ring.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(&(seq, started)) = ring.throttle.get(&key)
            && now.saturating_sub(started) < THROTTLE_WINDOW_MS
        {
            // A repeat inside the window only counts.
            if let Some((_, line)) = ring.lines.iter_mut().find(|(s, _)| *s == seq) {
                let fields = line.fields.get_or_insert_with(BTreeMap::new);
                let prior = match fields.get("repeatCount") {
                    Some(FieldValue::Number(n)) => *n,
                    _ => 1.0,
                };
                fields.insert("repeatCount".to_owned(), FieldValue::Number(prior + 1.0));
            }
            return;
        }

        let seq = ring.next_seq;
        ring.next_seq += 1;
        let line = DiagnosticLine {
            ts: iso(now),
            level: wire_level.to_owned(),
            scope: scope.to_owned(),
            message: redacted.message,
            error_code: None,
            fields: (!redacted.fields.is_empty()).then(|| {
                redacted
                    .fields
                    .into_iter()
                    .map(|(k, v)| (k, FieldValue::from_json(v)))
                    .collect()
            }),
            origin: "main".to_owned(),
            seq,
        };
        ring.throttle.insert(key, (seq, now));
        if ring.throttle.len() > THROTTLE_MAX_KEYS {
            ring.throttle
                .retain(|_, (_, started)| now.saturating_sub(*started) < THROTTLE_WINDOW_MS);
        }
        ring.lines.push_back((seq, line.clone()));
        while ring.lines.len() > RING_LIMIT {
            ring.lines.pop_front();
        }
        let cutoff = now.saturating_sub(RING_MS);
        while ring
            .lines
            .front()
            .is_some_and(|(_, l)| super::time::parse_iso(&l.ts).is_some_and(|t| t < cutoff))
        {
            ring.lines.pop_front();
        }
        drop(ring);
        self.queue.push(line);
    }
}

/// The layer logging installs. It reads [`global`] per event, so installing it before the
/// destination exists costs one atomic load per warn.
pub struct ShipLayer;

#[derive(Default)]
struct Collected {
    message: String,
    scope: Option<String>,
    fields: Map<String, Value>,
}

impl Visit for Collected {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let mut text = String::new();
        let _ = write!(text, "{value:?}");
        self.record_text(field.name(), text);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_text(field.name(), value.to_owned());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .insert(field.name().to_owned(), Value::from(value));
    }
}

impl Collected {
    fn record_text(&mut self, name: &str, text: String) {
        match name {
            "message" => self.message = text,
            "scope" => self.scope = Some(text.trim_matches('"').to_owned()),
            other => {
                self.fields.insert(other.to_owned(), Value::from(text));
            }
        }
    }
}

impl<S: Subscriber> Layer<S> for ShipLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>) {
        let level = *event.metadata().level();
        if level != Level::WARN && level != Level::ERROR {
            return;
        }
        let Some(ship) = INSTANCE.get() else { return };
        if ship.errors_only && level != Level::ERROR {
            return;
        }
        let mut collected = Collected::default();
        event.record(&mut collected);
        let scope = collected.scope.clone().unwrap_or_else(|| {
            event
                .metadata()
                .target()
                .rsplit("::")
                .next()
                .unwrap_or("app")
                .to_owned()
        });
        if SKIP_SCOPES.contains(&scope.as_str()) {
            return;
        }
        if REENTRANT.replace(true) {
            return;
        }
        ship.handle(&level, &scope, &collected.message, &collected.fields);
        REENTRANT.set(false);
    }
}
