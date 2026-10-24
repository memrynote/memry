use std::sync::Arc;

use memry_desktop::command_failure::{self, FailureDetails, FailureSink};
use serde::Serialize;

/// The class of a failure. Fixed set; the renderer branches on `kind`, never on message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Storage,
    Crypto,
    Auth,
    Api,
    Sync,
    Crdt,
    Recovery,
    PropertyWrite,
    SecureStore,
    Transport,
    Locked,
    NotFound,
    Invalid,
    Internal,
}

impl ErrorKind {
    /// The wire name of the variant.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "storage",
            Self::Crypto => "crypto",
            Self::Auth => "auth",
            Self::Api => "api",
            Self::Sync => "sync",
            Self::Crdt => "crdt",
            Self::Recovery => "recovery",
            Self::PropertyWrite => "propertyWrite",
            Self::SecureStore => "secureStore",
            Self::Transport => "transport",
            Self::Locked => "locked",
            Self::NotFound => "notFound",
            Self::Invalid => "invalid",
            Self::Internal => "internal",
        }
    }
}

/// What the renderer sees when a command rejects. Tauri serializes it as JSON, the shape
/// `extractErrorMessage` reads. Messages never carry secrets.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: ErrorKind,
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(kind: ErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// Log a command failure at warn level with the command name and forward it to the registered
/// sink through the throttle. Adapters call it in their `map_err`.
pub fn log_failure(command: &str, error: &CommandError) {
    command_failure::reporter().report(
        command,
        FailureDetails {
            kind: error.kind.as_str(),
            code: &error.code,
            message: &error.message,
        },
    );
}

/// Replace the sink that receives throttled failures. Step 09 (#3526) registers its telemetry
/// sink from `run()`.
pub fn register_sink(sink: Arc<dyn FailureSink>) {
    command_failure::reporter().register_sink(sink);
}
