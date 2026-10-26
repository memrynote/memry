//! Classification of a failure before it is reported: what is an expected condition (dropped),
//! what is an expected warning (reported as a log, never as an error), and the redacted detail
//! that ships (`diagnostics.ts`, `expected-conditions.ts`, `buildErrorDetail`).

use crate::redact::{RedactOptions, cap, redact_sensitive, redact_text};

use super::events::{ErrorDetail, to_safe_token};

const NETWORK_CODES: &[&str] = &[
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "ERR_HTTP2_PROTOCOL_ERROR",
    "ERR_NAME_NOT_RESOLVED",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NETWORK_CHANGED",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_CONNECTION_TIMED_OUT",
];

const NETWORK_MESSAGES: &[&str] = &[
    "no such host is known",
    "invalid peer certificate: unknownissuer",
    "invalid peer certificate:unknownissuer",
    "err_http2_protocol_error",
    "net::err_name_not_resolved",
    "net::err_internet_disconnected",
    "net::err_network_changed",
    "net::err_connection_reset",
    "net::err_connection_closed",
    "net::err_connection_timed_out",
];

/// What a reporter knows about a failure.
#[derive(Debug, Clone, Default)]
pub struct Failure {
    /// A typed code (`SQLITE_BUSY`), when the error has one.
    pub code: Option<String>,
    pub message: String,
    /// The error is a normal state of the world (user cancel): never reported.
    pub expected_condition: bool,
    /// The error is a known environmental failure: reported as a warning log, not an error.
    pub expected_warning: bool,
}

impl Failure {
    pub fn new(code: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            code: code.map(str::to_owned),
            message: message.into(),
            ..Self::default()
        }
    }

    /// An error caused by the network environment, not by the app.
    pub fn is_network_environment(&self) -> bool {
        let message = self.message.to_lowercase();
        self.code
            .as_deref()
            .is_some_and(|code| NETWORK_CODES.contains(&code))
            || NETWORK_MESSAGES
                .iter()
                .any(|needle| message.contains(needle))
    }

    pub fn is_expected_warning(&self) -> bool {
        self.expected_warning || self.is_network_environment()
    }
}

/// `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`
fn is_typed_code(code: &str) -> bool {
    let b = code.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphabetic()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
}

/// The code that ships: the typed code, else the class name.
pub fn error_code(failure: &Failure) -> String {
    failure
        .code
        .as_deref()
        .filter(|c| is_typed_code(c))
        .unwrap_or("Error")
        .to_owned()
}

/// The redacted, capped detail: the message through `redactText`, a stack through the coarse
/// scrub. With neither, the capture `site` is named.
pub fn error_detail(
    failure: &Failure,
    stack: Option<&str>,
    opts: &RedactOptions,
    site: &str,
) -> Option<ErrorDetail> {
    let mut detail = ErrorDetail::default();
    if !failure.message.is_empty() {
        let redacted = cap(&redact_text(&failure.message, opts), 512);
        if !redacted.is_empty() {
            detail.message = Some(redacted);
        }
    }
    if let Some(frames) = stack.map(frames_only).filter(|f| !f.is_empty()) {
        detail.stack = Some(cap(&redact_sensitive(&frames), 4000));
    }
    if detail.message.is_none() {
        detail.message = Some(format!(
            "{} reported with no message at {}",
            error_code(failure),
            to_safe_token(site, "unknown_site")
        ));
    }
    Some(detail)
}

/// Only `    at <fn> (<file>:<line>:<col>)` lines: the header may carry free text.
fn frames_only(stack: &str) -> String {
    stack
        .lines()
        .filter(|line| {
            line.trim_start().starts_with("at ") && line.starts_with(char::is_whitespace)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_network_environment_error_is_an_expected_warning() {
        assert!(Failure::new(Some("ENOTFOUND"), "x").is_expected_warning());
        assert!(
            Failure::new(None, "invalid peer certificate: UnknownIssuer").is_expected_warning()
        );
        assert!(!Failure::new(Some("SQLITE_BUSY"), "database is locked").is_expected_warning());
    }

    #[test]
    fn the_code_is_typed_or_the_class_and_the_detail_is_redacted() {
        assert_eq!(
            error_code(&Failure::new(Some("NOTE_WRITE_FAILED:EBUSY"), "")),
            "NOTE_WRITE_FAILED:EBUSY"
        );
        assert_eq!(
            error_code(&Failure::new(Some("/Users/kaan/x"), "")),
            "Error"
        );
        let detail = error_detail(
            &Failure::new(None, "cannot open /Users/kaan/a.md for kaan@example.com"),
            None,
            &RedactOptions::default(),
            "site",
        )
        .expect("detail");
        assert_eq!(
            detail.message.as_deref(),
            Some("cannot open ~/[name].md for <email>")
        );
        let empty = error_detail(&Failure::default(), None, &RedactOptions::default(), "a/b")
            .expect("detail");
        assert_eq!(
            empty.message.as_deref(),
            Some("Error reported with no message at a_b")
        );
    }
}
