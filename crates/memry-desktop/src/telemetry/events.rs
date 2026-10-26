//! The event schema of `packages/contracts/src/telemetry-api.ts`: the closed name list, the
//! dimension allowlist and the sanitizers, pinned by `telemetry-events.json`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::redact::is_safe_dimension_value;

pub const EVENT_NAMES: &[&str] = &[
    "app_started",
    "app_backgrounded",
    "app_active_heartbeat",
    "app_launch_phase_completed",
    "app_log_recorded",
    "onboarding_started",
    "onboarding_completed",
    "vault_created",
    "vault_opened",
    "page_viewed",
    "note_created",
    "note_opened",
    "note_updated",
    "note_deleted",
    "journal_opened",
    "journal_updated",
    "task_created",
    "task_completed",
    "task_reopened",
    "project_created",
    "inbox_captured",
    "inbox_filed",
    "inbox_archived",
    "inbox_snoozed",
    "search_opened",
    "search_performed",
    "search_result_opened",
    "calendar_event_created",
    "calendar_event_updated",
    "calendar_google_connected",
    "calendar_google_sync_completed",
    "readwise_connected",
    "readwise_sync_completed",
    "graph_opened",
    "setting_changed",
    "sync_enabled",
    "sync_run_completed",
    "sync_error",
    "voice_recording_completed",
    "transcription_completed",
    "ai_action_completed",
    "agent_chat_started",
    "agent_chat_message_sent",
    "command_palette_opened",
    "app_update_installed",
    "app_error_seen",
    "app_crashed",
    "canvas_sync_conflict_copy",
    "canvas_too_large",
    "sync_skipped_unknown_type",
    "canvas_asset_uploaded",
    "canvas_asset_dedup_hit",
    "canvas_asset_gc_reaped",
    "canvas_created",
    "canvas_opened",
    "canvas_deleted",
    "canvas_card_added",
    "project_opened",
    "project_updated",
    "project_archived",
    "project_deleted",
    "project_item_linked",
    "tag_created",
    "tag_renamed",
    "tag_deleted",
    "tag_merged",
    "tag_category_created",
    "task_updated",
    "task_deleted",
    "calendar_event_deleted",
    "calendar_google_disconnected",
    "readwise_disconnected",
    "note_imported",
    "note_exported",
    "import_completed",
    "deep_link_opened",
    "home_board_customized",
    "reminder_created",
    "reminder_deleted",
    "sync_bootstrap",
];

pub const SURFACES: &[&str] = &[
    "app",
    "home",
    "onboarding",
    "vault",
    "notes",
    "journal",
    "tasks",
    "inbox",
    "calendar",
    "search",
    "graph",
    "settings",
    "sync",
    "ai",
    "voice",
    "updater",
    "canvas",
    "projects",
    "tags",
];

pub const RESULTS: &[&str] = &["success", "failed", "canceled", "skipped"];

/// The only dimension keys allowed to leave the device.
pub const DIMENSION_KEYS: &[&str] = &[
    "capture_type",
    "changed_fields",
    "decision",
    "filed_action",
    "format",
    "from_version",
    "itemType",
    "log_action",
    "note_bucket",
    "prior_app_version",
    "result_bucket",
    "setting",
    "size_bucket",
    "skip_reason",
    "target",
    "target_app_version",
    "tool",
    "transport",
    "value",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_stack: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FailureDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub id: String,
    pub name: String,
    pub occurred_at: String,
    pub surface: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Metrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureDetail>,
}

impl TelemetryEvent {
    /// Whether the name, surface and result are members of the closed lists. The server
    /// rejects a whole batch for one bad event, so an event that fails this never queues.
    pub fn is_known(&self) -> bool {
        EVENT_NAMES.contains(&self.name.as_str())
            && SURFACES.contains(&self.surface.as_str())
            && self.result.as_deref().is_none_or(|r| RESULTS.contains(&r))
            && is_safe_dimension_value(&self.action)
    }
}

/// `sanitizeTelemetryDimensions`: at most one entry, with an allowlisted key and a safe value.
pub fn sanitize_dimensions(
    dimensions: Option<&BTreeMap<String, String>>,
) -> Option<BTreeMap<String, String>> {
    dimensions?.iter().find_map(|(key, value)| {
        (DIMENSION_KEYS.contains(&key.as_str()) && is_safe_dimension_value(value))
            .then(|| BTreeMap::from([(key.clone(), value.clone())]))
    })
}

fn is_server_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/// `sanitizeTelemetryFailure`: each field survives only when it satisfies the schema.
pub fn sanitize_failure(failure: Option<&FailureDetail>) -> Option<FailureDetail> {
    let failure = failure?;
    let safe = FailureDetail {
        http_status: failure.http_status.filter(|s| (100..=599).contains(s)),
        server_code: failure.server_code.clone().filter(|c| is_server_code(c)),
        retryable: failure.retryable,
    };
    // A failure that already satisfies the schema passes through whole, even when empty.
    if safe == *failure {
        return Some(safe);
    }
    (safe != FailureDetail::default()).then_some(safe)
}

/// `toSafeToken` for a string: every character outside `[A-Za-z0-9_.:-]` becomes `_`, then
/// 64 UTF-16 units are kept, and the result must pass the safe-token shape.
pub fn to_safe_token(value: &str, fallback: &str) -> String {
    let mut units = 0;
    let mut token = String::new();
    for ch in value.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-') {
            ch
        } else {
            '_'
        };
        // `replace(/[^...]/g, '_')` runs per UTF-16 unit: a surrogate pair becomes two `_`.
        let width = if mapped == '_' && !ch.is_ascii() {
            ch.len_utf16()
        } else {
            1
        };
        for _ in 0..width {
            if units == 64 {
                break;
            }
            token.push(mapped);
            units += 1;
        }
    }
    if crate::redact::is_safe_token(&token) {
        token
    } else {
        fallback.to_owned()
    }
}
