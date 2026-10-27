//! Renderer log forwarding: `log_write` puts a renderer record into `main.log`, where the log
//! pipeline redacts and ships it like a main-process one.

use serde::Deserialize;
use serde_json::Value;
use tracing::Level;

use super::error::CommandError;

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Verbose,
    Debug,
}

/// The record's text is capped: a renderer cannot grow a log line without bound.
const MESSAGE_CAP: usize = 4000;

#[tauri::command]
#[specta::specta]
pub async fn log_write(
    level: LogLevel,
    scope: String,
    message: String,
    fields: Option<Value>,
) -> Result<(), CommandError> {
    let scope: String = scope.chars().take(64).collect();
    let message: String = message.chars().take(MESSAGE_CAP).collect();
    let message = match fields {
        Some(fields) => format!(
            "{message} {}",
            fields
                .to_string()
                .chars()
                .take(MESSAGE_CAP)
                .collect::<String>()
        ),
        None => message,
    };
    match level {
        LogLevel::Error => tracing::event!(Level::ERROR, scope = %scope, "{message}"),
        LogLevel::Warn => tracing::event!(Level::WARN, scope = %scope, "{message}"),
        LogLevel::Info => tracing::event!(Level::INFO, scope = %scope, "{message}"),
        LogLevel::Verbose | LogLevel::Debug => {
            tracing::event!(Level::DEBUG, scope = %scope, "{message}")
        }
    }
    Ok(())
}
