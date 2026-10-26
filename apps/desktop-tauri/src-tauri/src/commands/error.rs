use std::sync::Arc;

use memry_desktop::command_failure::{self, FailureDetails, FailureSink};
use memry_desktop::error::{CoreError, FailureKind, map_core};
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

impl From<FailureKind> for ErrorKind {
    fn from(kind: FailureKind) -> Self {
        match kind {
            FailureKind::Storage => Self::Storage,
            FailureKind::Crypto => Self::Crypto,
            FailureKind::Auth => Self::Auth,
            FailureKind::Api => Self::Api,
            FailureKind::Sync => Self::Sync,
            FailureKind::Crdt => Self::Crdt,
            FailureKind::Recovery => Self::Recovery,
            FailureKind::PropertyWrite => Self::PropertyWrite,
            FailureKind::SecureStore => Self::SecureStore,
            FailureKind::Transport => Self::Transport,
            FailureKind::Locked => Self::Locked,
            FailureKind::NotFound => Self::NotFound,
            FailureKind::Invalid => Self::Invalid,
            FailureKind::Internal => Self::Internal,
        }
    }
}

impl CommandError {
    /// A core error as the renderer sees it (`memry_desktop::error::map_core`).
    pub fn from_core<E: CoreError>(error: &E) -> Self {
        let failure = map_core(error);
        Self::new(failure.kind.into(), failure.code, failure.message)
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
    // `SQLITE_CORRUPT` from a query with the vault open: the user is offered repair, once.
    if error.kind == ErrorKind::Recovery && error.code == "storage_corrupt" {
        crate::shell::vault_boot::offer_runtime_repair_if_ready();
    }
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
