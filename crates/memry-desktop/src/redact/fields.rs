//! Structured field redaction: an allowlist plus one strategy per key.

use serde_json::{Map, Value};

use super::{RedactOptions, cap, redact_text};

const VERBATIM: &[&str] = &[
    "level",
    "scope",
    "action",
    "errorCode",
    "appVersion",
    "buildChannel",
    "platform",
    "arch",
    "origin",
    "workerName",
    "reason",
    "phase",
    "mode",
    "status",
    "kind",
    "result",
];
const NUMERIC: &[&str] = &[
    "durationMs",
    "itemCount",
    "queueCount",
    "retryCount",
    "byteCount",
    "resultCount",
    "value",
    "count",
    "droppedCount",
    "sequenceNum",
    "pageCount",
    "attempt",
    "size",
    "exitCode",
    // Startup phase offsets of the launch timeline.
    "appReadyMs",
    "windowCreatedMs",
    "vaultOpenStartMs",
    "vaultOpenReadyMs",
    "rendererLoadedMs",
    "readyToShowMs",
    "shownMs",
];
const IDS: &[&str] = &[
    "noteId",
    "journalId",
    "taskId",
    "projectId",
    "attachmentId",
    "deviceId",
    "vaultId",
    "signerDeviceId",
    "installId",
    "sessionId",
    "blockId",
    "itemId",
];

const MESSAGE_CAP: usize = 2000;
const FIELD_VALUE_CAP: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct RedactedLine {
    pub message: String,
    pub fields: Map<String, Value>,
}

fn stringify(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn redact_field(key: &str, value: &Value, opts: &RedactOptions) -> Value {
    if VERBATIM.contains(&key) {
        return match value {
            Value::String(text) => Value::String(cap(&redact_text(text, opts), FIELD_VALUE_CAP)),
            other => other.clone(),
        };
    }
    // An id hashes whatever its type: a numeric id must not ride the number passthrough.
    if IDS.contains(&key) {
        let text = stringify(value);
        if text.is_empty() {
            return Value::String(text);
        }
        return Value::String(match opts.hash {
            Some(hash) => hash(&text).chars().take(10).collect(),
            None => "<id>".to_owned(),
        });
    }
    if let Value::Bool(_) = value {
        return value.clone();
    }
    // A number is a metric only under a known metric key.
    if let Value::Number(number) = value
        && number.as_f64().is_some_and(f64::is_finite)
        && NUMERIC.contains(&key)
    {
        return value.clone();
    }
    Value::String(cap(&redact_text(&stringify(value), opts), FIELD_VALUE_CAP))
}

pub fn redact_log_line(
    message: &str,
    fields: &Map<String, Value>,
    opts: &RedactOptions,
) -> RedactedLine {
    RedactedLine {
        message: cap(&redact_text(message, opts), MESSAGE_CAP),
        fields: fields
            .iter()
            .map(|(key, value)| (key.clone(), redact_field(key, value, opts)))
            .collect(),
    }
}
