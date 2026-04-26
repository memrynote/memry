//! PII-safe redaction helpers used in M4 error and log paths.
//!
//! These helpers are the only correct way to surface untrusted user
//! strings (emails, URLs, provider keys, bearer tokens, note titles) to
//! tracing fields, error messages, or any other observable channel.
//!
//! Two patterns:
//!
//! - `redact_email` and `redact_url` preserve a small structural hint
//!   (first char + domain, scheme/host/path) so logs stay debuggable.
//! - `redact_secret` and `RedactionKind::ProviderKey | BearerToken |
//!   NoteTitle` drop the value entirely and replace it with a stable
//!   `<redacted:...>` marker.
//!
//! `sanitize_log_field` is the single dispatcher tracing/error code
//! should call. The kind argument forces the call site to declare the
//! shape of the value, avoiding "I'll just redact it later" patterns.

/// Categories accepted by `sanitize_log_field`. Each variant maps to a
/// concrete redaction strategy: structural mask for `Email` / `Url`,
/// constant marker for everything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactionKind {
    Email,
    Url,
    ProviderKey,
    BearerToken,
    NoteTitle,
}

const REDACTED_EMAIL: &str = "<redacted:email>";
const REDACTED_URL: &str = "<redacted:url>";
const REDACTED_SECRET: &str = "<redacted:secret>";
const REDACTED_PROVIDER_KEY: &str = "<redacted:provider-key>";
const REDACTED_TOKEN: &str = "<redacted:token>";
const REDACTED_TITLE: &str = "<redacted:title>";

/// Returns `<first-char>***@<domain>` for an email-shaped input;
/// returns `<redacted:email>` for anything that does not parse.
pub fn redact_email(input: &str) -> String {
    let Some((local, domain)) = input.split_once('@') else {
        return REDACTED_EMAIL.to_string();
    };
    if local.is_empty() || domain.is_empty() {
        return REDACTED_EMAIL.to_string();
    }
    let first_char = local.chars().next().unwrap_or('_');
    format!("{first_char}***@{domain}")
}

/// Strips the query string from a parseable URL, leaving the
/// scheme/host/path intact. The literal `?<redacted>` marker is
/// appended only when the input had query params, so callers can tell
/// "no query" from "query stripped". Inputs that do not look like a
/// URL fall back to the `<redacted:url>` constant.
pub fn redact_url(input: &str) -> String {
    if input.is_empty() {
        return REDACTED_URL.to_string();
    }
    if !looks_like_url(input) {
        return REDACTED_URL.to_string();
    }
    if let Some((before, _after)) = input.split_once('?') {
        return format!("{before}?<redacted>");
    }
    input.to_string()
}

/// Constant-only redaction for arbitrary secret bytes. The `_input`
/// parameter is consumed so callers cannot accidentally log it after
/// the call, but it is never inspected.
pub fn redact_secret(_input: &str) -> &'static str {
    REDACTED_SECRET
}

/// Single dispatch for tracing / error fields. Forces the caller to
/// declare the kind of the value being logged.
pub fn sanitize_log_field(kind: RedactionKind, value: &str) -> String {
    match kind {
        RedactionKind::Email => redact_email(value),
        RedactionKind::Url => redact_url(value),
        RedactionKind::ProviderKey => REDACTED_PROVIDER_KEY.to_string(),
        RedactionKind::BearerToken => REDACTED_TOKEN.to_string(),
        RedactionKind::NoteTitle => REDACTED_TITLE.to_string(),
    }
}

fn looks_like_url(input: &str) -> bool {
    let lower = input.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && input.contains("://")
}
