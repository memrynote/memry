use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("database error: {0}")]
    Database(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("vault locked")]
    VaultLocked,
    #[error("invalid password")]
    InvalidPassword,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("vault error: {0}")]
    Vault(String),
    #[error("path escape: {0}")]
    PathEscape(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("rate limited: retry after {0:?} seconds")]
    RateLimited(Option<u64>),
    #[error("crdt error: {0}")]
    Crdt(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Database(err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Validation(err.to_string())
    }
}

impl From<serde_yaml_ng::Error> for AppError {
    fn from(err: serde_yaml_ng::Error) -> Self {
        AppError::Validation(format!("yaml: {err}"))
    }
}

impl From<notify::Error> for AppError {
    fn from(err: notify::Error) -> Self {
        AppError::Vault(format!("watcher: {err}"))
    }
}

impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(err: std::sync::PoisonError<T>) -> Self {
        AppError::Internal(err.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::Network(err.to_string())
    }
}

impl From<yrs::error::Error> for AppError {
    fn from(err: yrs::error::Error) -> Self {
        AppError::Crdt(err.to_string())
    }
}

impl From<yrs::encoding::read::Error> for AppError {
    fn from(err: yrs::encoding::read::Error) -> Self {
        AppError::Crdt(format!("decode: {err}"))
    }
}

impl From<yrs::error::UpdateError> for AppError {
    fn from(err: yrs::error::UpdateError) -> Self {
        AppError::Crdt(format!("apply: {err}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
