//! macOS Calendar (#3546 29h): the client of `memry-eventkit`, the Swift helper in
//! `apps/desktop-tauri/eventkit/` that reads EventKit, ported from Electron's
//! `calendar/eventkit/eventkit-bridge.ts` and `eventkit-loader.ts`.
//!
//! The helper speaks newline-delimited JSON on stdin and stdout (`{"id","method","params"}`, the
//! unsolicited `{"event":"changed"}`). It is spawned on first use and respawned by the next call
//! after it exits; it exits when its stdin closes, so it never outlives the app. macOS answers
//! the permission prompt for the app that spawned it (its responsible process), so the prompt
//! names MemryNote. Off macOS nothing here spawns anything: [`EventKit::load`] answers
//! [`Load::UnsupportedPlatform`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, broadcast, oneshot};

const SCOPE: &str = "calendar_eventkit";
/// The helper's file name: `bundle.externalBin` puts it in `Contents/MacOS`, beside the app.
pub const HELPER_NAME: &str = "memry-eventkit";
/// `DEFAULT_REQUEST_TIMEOUT_MS`. The permission request has none: the user may leave the system
/// dialog open for as long as they like.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// `EKAuthorizationStatus` for events. `write_only` (macOS 14+) cannot read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
// Electron's name in the generated bindings.
#[serde(rename = "EventKitAuthorizationStatus", rename_all = "snake_case")]
pub enum AuthorizationStatus {
    NotDetermined,
    Restricted,
    Denied,
    WriteOnly,
    FullAccess,
}

impl AuthorizationStatus {
    /// `toStatus`: an answer the bridge does not know reads as denied.
    fn parse(value: &Value) -> Self {
        match value.as_str() {
            Some("not_determined") => Self::NotDetermined,
            Some("restricted") => Self::Restricted,
            Some("write_only") => Self::WriteOnly,
            Some("full_access") => Self::FullAccess,
            _ => Self::Denied,
        }
    }
}

/// An `EKCalendar`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub title: String,
    /// `#rrggbb` in sRGB.
    pub color: Option<String>,
    /// `local`, `caldav`, `exchange`, `subscription`, `birthday`.
    pub r#type: String,
    pub allows_modifications: bool,
    pub source_id: Option<String>,
    pub source_title: Option<String>,
    pub source_type: Option<String>,
}

/// An `EKParticipant`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub name: Option<String>,
    pub email: Option<String>,
    pub status: String,
    pub role: String,
    pub r#type: String,
    pub is_current_user: bool,
}

/// One occurrence of an `EKEvent`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub calendar_id: String,
    pub event_id: Option<String>,
    pub external_id: Option<String>,
    pub title: String,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub is_all_day: bool,
    pub start: Option<String>,
    pub end: Option<String>,
    pub time_zone: Option<String>,
    pub start_date: Option<String>,
    pub last_date: Option<String>,
    /// `none`, `confirmed`, `tentative`, `canceled`.
    pub status: String,
    pub availability: String,
    pub is_recurring: bool,
    pub last_modified: Option<String>,
    pub occurrence_start: Option<String>,
    pub attendees: Vec<Participant>,
    pub organizer: Option<Participant>,
    pub alarm_minutes: Vec<f64>,
    pub recurrence_rule: Option<String>,
}

/// `EventKitBridgeError`: the helper's error code (`not_authorized`, `span_too_long`, ...) or
/// the bridge's own (`helper_unavailable`, `helper_exited`, `timeout`, `disposed`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

type Reply = oneshot::Sender<Result<Value, BridgeError>>;

struct Helper {
    stdin: ChildStdin,
    child: Child,
    generation: u64,
}

#[derive(Default)]
struct State {
    helper: Option<Helper>,
    generation: u64,
    next_id: u64,
    /// Request id to the helper generation it was written to, and its reply.
    pending: HashMap<u64, (u64, Reply)>,
    disposed: bool,
}

impl State {
    fn fail(&mut self, generation: Option<u64>, error: &BridgeError) {
        let ids: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, (owner, _))| generation.is_none_or(|g| g == *owner))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some((_, reply)) = self.pending.remove(&id) {
                let _ = reply.send(Err(error.clone()));
            }
        }
    }
}

/// `createEventKitBridge`.
pub struct Bridge {
    command: PathBuf,
    timeout: Duration,
    state: Arc<Mutex<State>>,
    changed: broadcast::Sender<()>,
}

impl Bridge {
    pub fn new(command: PathBuf, timeout: Duration) -> Self {
        Self {
            command,
            timeout,
            state: Arc::new(Mutex::new(State::default())),
            changed: broadcast::channel(16).0,
        }
    }

    pub async fn authorization_status(&self) -> Result<AuthorizationStatus, BridgeError> {
        let result = self.request("authorizationStatus", json!({}), true).await?;
        Ok(AuthorizationStatus::parse(&result))
    }

    /// Shows the macOS dialog only when the status is `not_determined`; otherwise the helper
    /// answers the current status at once.
    pub async fn request_full_access(&self) -> Result<AuthorizationStatus, BridgeError> {
        let result = self.request("requestFullAccess", json!({}), false).await?;
        Ok(AuthorizationStatus::parse(&result))
    }

    pub async fn list_calendars(&self) -> Result<Vec<Calendar>, BridgeError> {
        let result = self.request("listCalendars", json!({}), true).await?;
        Ok(records(&result).filter_map(calendar).collect())
    }

    /// Occurrences in `[start, end)` (ISO times); the helper refuses a span over four years.
    pub async fn list_events(
        &self,
        calendar_ids: &[String],
        start: &str,
        end: &str,
    ) -> Result<Vec<Event>, BridgeError> {
        if calendar_ids.is_empty() {
            return Ok(Vec::new());
        }
        let params = json!({ "calendarIds": calendar_ids, "start": start, "end": end });
        let result = self.request("listEvents", params, true).await?;
        Ok(records(&result).filter_map(event).collect())
    }

    /// `EKEventStoreChanged`. Notifications flow only while the helper runs, so this starts it.
    pub async fn subscribe_changed(&self) -> broadcast::Receiver<()> {
        let receiver = self.changed.subscribe();
        if let Err(error) = self.spawn_if_needed(&mut *self.state.lock().await) {
            tracing::warn!(scope = SCOPE, code = %error.code, "EventKit helper unavailable for change notifications");
        }
        receiver
    }

    /// Fails every pending call, closes the helper's stdin and stops it. Later calls fail with
    /// `disposed`.
    pub async fn dispose(&self) {
        let mut state = self.state.lock().await;
        if state.disposed {
            return;
        }
        state.disposed = true;
        state.fail(None, &BridgeError::new("disposed", "disposed"));
        if let Some(mut helper) = state.helper.take() {
            let _ = helper.stdin.shutdown().await;
            if let Err(error) = helper.child.start_kill() {
                tracing::warn!(scope = SCOPE, %error, "could not stop the EventKit helper");
            }
        }
    }

    async fn request(
        &self,
        method: &'static str,
        params: Value,
        timed: bool,
    ) -> Result<Value, BridgeError> {
        let (reply, answer) = oneshot::channel();
        let id = {
            let mut state = self.state.lock().await;
            self.spawn_if_needed(&mut state)?;
            state.next_id += 1;
            let id = state.next_id;
            let generation = state.generation;
            state.pending.insert(id, (generation, reply));
            let line = format!(
                "{}\n",
                json!({ "id": id, "method": method, "params": params })
            );
            if let Some(helper) = state.helper.as_mut()
                && let Err(error) = helper.stdin.write_all(line.as_bytes()).await
            {
                // The helper died; its reader fails this request with `helper_exited`.
                tracing::debug!(scope = SCOPE, %error, "write to the EventKit helper failed");
            }
            id
        };
        let answered = if timed {
            match tokio::time::timeout(self.timeout, answer).await {
                Ok(answered) => answered,
                Err(_) => {
                    self.state.lock().await.pending.remove(&id);
                    return Err(BridgeError::new("timeout", method));
                }
            }
        } else {
            answer.await
        };
        answered.unwrap_or_else(|_| Err(BridgeError::new("helper_exited", "no reply")))
    }

    fn spawn_if_needed(&self, state: &mut State) -> Result<(), BridgeError> {
        if state.disposed {
            return Err(BridgeError::new("disposed", "disposed"));
        }
        if state.helper.is_some() {
            return Ok(());
        }
        let mut child = Command::new(&self.command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                tracing::warn!(scope = SCOPE, %error, "EventKit helper could not start");
                BridgeError::new("helper_unavailable", error.to_string())
            })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(BridgeError::new("helper_unavailable", "no pipes"));
        };
        state.generation += 1;
        let generation = state.generation;
        state.helper = Some(Helper {
            stdin,
            child,
            generation,
        });
        tokio::spawn(read_replies(
            stdout,
            generation,
            self.state.clone(),
            self.changed.clone(),
        ));
        tokio::spawn(log_stderr(stderr));
        Ok(())
    }
}

/// Answers each reply line until the helper's stdout closes, then fails what the helper left
/// unanswered.
async fn read_replies(
    stdout: impl AsyncRead + Unpin,
    generation: u64,
    state: Arc<Mutex<State>>,
    changed: broadcast::Sender<()>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(_) => dispatch(&String::from_utf8_lossy(&line), &state, &changed).await,
            Err(error) => {
                tracing::warn!(scope = SCOPE, %error, "reading the EventKit helper failed");
                break;
            }
        }
    }
    let exited = {
        let mut state = state.lock().await;
        let current = state.helper.as_ref().map(|helper| helper.generation);
        if current == Some(generation) {
            state.helper.take()
        } else {
            None
        }
    };
    // `None`: disposed, which already failed every request and stopped the helper.
    let Some(mut helper) = exited else { return };
    let code = match helper.child.wait().await {
        Ok(status) => status
            .code()
            .map_or_else(|| "null".to_owned(), |code| code.to_string()),
        Err(_) => "null".to_owned(),
    };
    tracing::info!(scope = SCOPE, code = %code, "EventKit helper exited");
    let error = BridgeError::new("helper_exited", format!("code {code}"));
    state.lock().await.fail(Some(generation), &error);
}

async fn dispatch(line: &str, state: &Mutex<State>, changed: &broadcast::Sender<()>) {
    if line.trim().is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        tracing::warn!(scope = SCOPE, "unreadable line from the EventKit helper");
        return;
    };
    if message.get("event").and_then(Value::as_str) == Some("changed") {
        // No receiver is not a failure: nothing listens yet.
        let _ = changed.send(());
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some((_, reply)) = state.lock().await.pending.remove(&id) else {
        return;
    };
    let answer = match message.get("error").filter(|error| !error.is_null()) {
        Some(error) => {
            let code = error.get("code").and_then(Value::as_str);
            let detail = error.get("message").and_then(Value::as_str);
            let code = code.unwrap_or("helper_error");
            Err(BridgeError::new(code, detail.unwrap_or(code)))
        }
        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
    };
    // The caller timed out and left.
    let _ = reply.send(answer);
}

async fn log_stderr(stderr: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(scope = SCOPE, line = %line.trim(), "EventKit helper stderr");
    }
}

fn records(value: &Value) -> impl Iterator<Item = &Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.is_object())
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn flag(raw: &Value, key: &str) -> bool {
    raw.get(key).and_then(Value::as_bool) == Some(true)
}

fn calendar(raw: &Value) -> Option<Calendar> {
    let id = text(raw, "id")?;
    Some(Calendar {
        title: text(raw, "title").unwrap_or_else(|| id.clone()),
        color: text(raw, "color"),
        r#type: text(raw, "type").unwrap_or_else(|| "unknown".to_owned()),
        allows_modifications: flag(raw, "allowsModifications"),
        source_id: text(raw, "sourceId"),
        source_title: text(raw, "sourceTitle"),
        source_type: text(raw, "sourceType"),
        id,
    })
}

fn participant(raw: &Value) -> Participant {
    Participant {
        name: text(raw, "name"),
        email: text(raw, "email"),
        status: text(raw, "status").unwrap_or_else(|| "pending".to_owned()),
        role: text(raw, "role").unwrap_or_else(|| "unknown".to_owned()),
        r#type: text(raw, "type").unwrap_or_else(|| "unknown".to_owned()),
        is_current_user: flag(raw, "isCurrentUser"),
    }
}

fn event(raw: &Value) -> Option<Event> {
    const STATUSES: [&str; 4] = ["none", "confirmed", "tentative", "canceled"];
    let status = raw
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| STATUSES.contains(status))
        .unwrap_or("none");
    Some(Event {
        calendar_id: text(raw, "calendarId")?,
        event_id: text(raw, "eventId"),
        external_id: text(raw, "externalId"),
        title: raw
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        location: text(raw, "location"),
        notes: text(raw, "notes"),
        url: text(raw, "url"),
        is_all_day: flag(raw, "isAllDay"),
        start: text(raw, "start"),
        end: text(raw, "end"),
        time_zone: text(raw, "timeZone"),
        start_date: text(raw, "startDate"),
        last_date: text(raw, "lastDate"),
        status: status.to_owned(),
        availability: text(raw, "availability").unwrap_or_else(|| "not_supported".to_owned()),
        is_recurring: flag(raw, "isRecurring"),
        last_modified: text(raw, "lastModified"),
        occurrence_start: text(raw, "occurrenceStart"),
        attendees: records(raw.get("attendees").unwrap_or(&Value::Null))
            .map(participant)
            .collect(),
        organizer: raw
            .get("organizer")
            .filter(|organizer| organizer.is_object())
            .map(participant),
        alarm_minutes: raw
            .get("alarmMinutes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_f64)
            .collect(),
        recurrence_rule: text(raw, "recurrenceRule"),
    })
}

/// `EventKitBridgeLoad`.
pub enum Load {
    Available(Arc<Bridge>),
    /// Windows or Linux: the helper does not exist there and nothing is spawned.
    UnsupportedPlatform,
    /// macOS, but the helper is missing. The rest of the app carries on.
    Unavailable,
}

/// Why the access request answered no status: the codes Electron's `connectApple` answers,
/// which the settings panel localizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessError {
    UnsupportedPlatform,
    Unavailable,
    PermissionDenied,
    Failed,
}

impl AccessError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::Unavailable => "unavailable",
            Self::PermissionDenied => "permission_denied",
            Self::Failed => "sync_failed",
        }
    }

    /// `passErrorCode`.
    fn of(error: &BridgeError) -> Self {
        match error.code.as_str() {
            "not_authorized" => Self::PermissionDenied,
            "helper_unavailable" | "helper_exited" | "disposed" | "timeout" => Self::Unavailable,
            _ => Self::Failed,
        }
    }
}

/// The app's one bridge (`loadEventKitBridge`), loaded on first use.
pub struct EventKit {
    os: &'static str,
    helper: PathBuf,
    bridge: Mutex<Option<Arc<Bridge>>>,
}

impl EventKit {
    /// `os` is `std::env::consts::OS`; `helper` is [`EventKit::beside`] the app binary.
    pub fn new(os: &'static str, helper: PathBuf) -> Self {
        Self {
            os,
            helper,
            bridge: Mutex::new(None),
        }
    }

    /// The bundler puts `bundle.externalBin` in `Contents/MacOS`, and `tauri-build` copies it
    /// beside a dev build's binary too.
    pub fn beside(exe: &Path) -> PathBuf {
        exe.with_file_name(HELPER_NAME)
    }

    /// Off macOS, `UnsupportedPlatform` without touching the helper. A missing helper is checked
    /// again on the next call rather than cached.
    pub async fn load(&self) -> Load {
        if self.os != "macos" {
            return Load::UnsupportedPlatform;
        }
        let mut bridge = self.bridge.lock().await;
        if let Some(bridge) = bridge.as_ref() {
            return Load::Available(bridge.clone());
        }
        if !self.helper.is_file() {
            tracing::warn!(scope = SCOPE, helper = %self.helper.display(), "EventKit helper not found");
            return Load::Unavailable;
        }
        let loaded = Arc::new(Bridge::new(self.helper.clone(), REQUEST_TIMEOUT));
        *bridge = Some(loaded.clone());
        Load::Available(loaded)
    }

    /// The access step of `connectApple`: the macOS dialog appears only when the user has
    /// never answered; any other status is answered as it stands.
    pub async fn request_access(&self) -> Result<AuthorizationStatus, AccessError> {
        let bridge = match self.load().await {
            Load::Available(bridge) => bridge,
            Load::UnsupportedPlatform => return Err(AccessError::UnsupportedPlatform),
            Load::Unavailable => return Err(AccessError::Unavailable),
        };
        let failed = |error: BridgeError| {
            tracing::warn!(scope = SCOPE, code = %error.code, "macOS Calendar access request failed");
            AccessError::of(&error)
        };
        let status = bridge.authorization_status().await.map_err(failed)?;
        if status != AuthorizationStatus::NotDetermined {
            return Ok(status);
        }
        bridge.request_full_access().await.map_err(failed)
    }
}
