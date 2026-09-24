//! Task settings (spec 004 TP023): desktop's `TaskSettings` group, read with
//! desktop's defaults and written through the synced-settings merge.
//!
//! Three fields ride the synced `settings` item under the `tasks` group
//! (`SyncedSettingsSchema.tasks`, chapter 06 §6.9): `defaultProjectId`,
//! `defaultSortOrder`, `staleInboxDays`. Each write goes through
//! [`settings::set`] / [`settings::clear`], so it ticks the leaf's dotted-path
//! field clock, commits with its outbox row, and carries every other group and
//! key — `tasks.showCompleted`, `tasks.sortBy`, groups this build does not
//! model — through verbatim (chapter 13 §13.10).
//!
//! `defaultView` is **not** on the wire: desktop keeps it in its local
//! `settings` table only (`settings-schemas.ts` `TaskSettingsSchema`, absent
//! from `settings-sync.ts`). Here it lives in the device-local `meta` table
//! under [`DEFAULT_VIEW_META_KEY`], never in the synced payload.
//!
//! Reads coerce like desktop's schema: a value that is absent, of the wrong
//! type, not one of the enum members, or out of range reads as its default
//! (`TASK_SETTINGS_DEFAULTS`). Writes refuse such values instead of storing
//! them, so this device never publishes a value desktop's schema rejects.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::settings;

/// Every `defaultSortOrder` desktop accepts, in its enum order.
pub const SORT_ORDERS: [&str; 4] = ["manual", "dueDate", "priority", "createdAt"];

/// Every `defaultView` desktop accepts, in its enum order.
pub const VIEWS: [&str; 4] = ["today", "tomorrow", "next7", "all"];

pub const DEFAULT_SORT_ORDER: &str = "manual";
pub const DEFAULT_VIEW: &str = "all";
pub const DEFAULT_STALE_INBOX_DAYS: i64 = 7;

/// `staleInboxDays` bounds, inclusive (`z.number().int().min(1).max(90)`).
pub const STALE_INBOX_DAYS_MIN: i64 = 1;
pub const STALE_INBOX_DAYS_MAX: i64 = 90;

/// The device-local `meta` key holding `defaultView`.
pub const DEFAULT_VIEW_META_KEY: &str = "tasks.default_view";

const GROUP: &str = "tasks";
const DEFAULT_PROJECT_ID: &str = "defaultProjectId";
const DEFAULT_SORT_ORDER_KEY: &str = "defaultSortOrder";
const STALE_INBOX_DAYS: &str = "staleInboxDays";

/// Desktop's `TaskSettings`, every field resolved to a valid value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSettings {
    /// `None` when unset or cleared: new tasks fall through to the inbox.
    pub default_project_id: Option<String>,
    /// One of [`SORT_ORDERS`].
    pub default_sort_order: String,
    /// One of [`VIEWS`]. Device-local.
    pub default_view: String,
    /// In `STALE_INBOX_DAYS_MIN..=STALE_INBOX_DAYS_MAX`.
    pub stale_inbox_days: i64,
}

impl Default for TaskSettings {
    fn default() -> Self {
        Self {
            default_project_id: None,
            default_sort_order: DEFAULT_SORT_ORDER.to_owned(),
            default_view: DEFAULT_VIEW.to_owned(),
            stale_inbox_days: DEFAULT_STALE_INBOX_DAYS,
        }
    }
}

/// The task settings this device sees: the synced `tasks` group plus the local
/// `defaultView`, each coerced to its default when missing or invalid.
///
/// A settings payload that will not parse is an error, as in
/// [`settings::all`], rather than a silent set of defaults.
pub fn read(conn: &Connection) -> Result<TaskSettings, StorageError> {
    let all = settings::all(conn)?;
    let group = all.get(GROUP).and_then(Value::as_object);
    let field = |key: &str| group.and_then(|group: &Map<String, Value>| group.get(key));

    let default_project_id = field(DEFAULT_PROJECT_ID)
        .and_then(Value::as_str)
        .map(str::to_owned);
    let default_sort_order = field(DEFAULT_SORT_ORDER_KEY)
        .and_then(Value::as_str)
        .filter(|value| SORT_ORDERS.contains(value))
        .unwrap_or(DEFAULT_SORT_ORDER)
        .to_owned();
    let stale_inbox_days = field(STALE_INBOX_DAYS)
        .and_then(whole_number)
        .filter(|days| (STALE_INBOX_DAYS_MIN..=STALE_INBOX_DAYS_MAX).contains(days))
        .unwrap_or(DEFAULT_STALE_INBOX_DAYS);
    let default_view = read_meta(conn, DEFAULT_VIEW_META_KEY)?
        .filter(|value| VIEWS.contains(&value.as_str()))
        .unwrap_or_else(|| DEFAULT_VIEW.to_owned());

    Ok(TaskSettings {
        default_project_id,
        default_sort_order,
        default_view,
        stale_inbox_days,
    })
}

/// Sets `tasks.defaultProjectId`; `None` writes an explicit `null` (§13.4), so
/// the clear wins over a peer's older project id. Synced.
pub fn set_default_project(
    conn: &Connection,
    project_id: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskSettings, StorageError> {
    let path = path(DEFAULT_PROJECT_ID);
    match project_id {
        Some(id) => settings::set(conn, &path, Value::from(id), device_id, now_ms)?,
        None => settings::clear(conn, &path, device_id, now_ms)?,
    };
    read(conn)
}

/// Sets `tasks.defaultSortOrder`. Refuses a value outside [`SORT_ORDERS`].
/// Synced.
pub fn set_default_sort_order(
    conn: &Connection,
    sort_order: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskSettings, StorageError> {
    if !SORT_ORDERS.contains(&sort_order) {
        return Err(refused(DEFAULT_SORT_ORDER_KEY, sort_order));
    }
    settings::set(
        conn,
        &path(DEFAULT_SORT_ORDER_KEY),
        Value::from(sort_order),
        device_id,
        now_ms,
    )?;
    read(conn)
}

/// Sets `tasks.staleInboxDays`. Refuses a value outside
/// `STALE_INBOX_DAYS_MIN..=STALE_INBOX_DAYS_MAX`. Synced.
pub fn set_stale_inbox_days(
    conn: &Connection,
    days: i64,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskSettings, StorageError> {
    if !(STALE_INBOX_DAYS_MIN..=STALE_INBOX_DAYS_MAX).contains(&days) {
        return Err(refused(STALE_INBOX_DAYS, &days.to_string()));
    }
    settings::set(
        conn,
        &path(STALE_INBOX_DAYS),
        Value::from(days),
        device_id,
        now_ms,
    )?;
    read(conn)
}

/// Sets `defaultView` in the device-local `meta` table. Refuses a value
/// outside [`VIEWS`]. Never synced: no payload changes, no outbox row.
pub fn set_default_view(conn: &Connection, view: &str) -> Result<TaskSettings, StorageError> {
    if !VIEWS.contains(&view) {
        return Err(refused("defaultView", view));
    }
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DEFAULT_VIEW_META_KEY, view],
    )
    .map_err(failed)?;
    read(conn)
}

fn path(key: &str) -> String {
    format!("{GROUP}.{key}")
}

/// An integer, including one JSON spells with a zero fraction (`7.0`). A
/// fractional number is not an integer and reads as absent. The float cast
/// saturates, and the caller's range check rejects a saturated value.
fn whole_number(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    let number = value.as_f64()?;
    (number.fract() == 0.0).then_some(number as i64)
}

fn read_meta(conn: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(failed)
}

fn refused(key: &str, value: &str) -> StorageError {
    StorageError::Failed {
        what: format!("tasks.{key}: `{value}` is not a valid value"),
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
