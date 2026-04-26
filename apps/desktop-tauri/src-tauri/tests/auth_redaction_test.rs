//! Tests for `auth::redaction` PII-safe redaction helpers.
//!
//! Every M4 error/log path that may receive untrusted strings must run
//! the value through one of these helpers before emitting it. The
//! helpers must never echo back password bytes, provider keys, bearer
//! tokens, OAuth codes, full email addresses, URL query params, or
//! note titles. For email and URL specifically, the helpers preserve a
//! small structural hint (first char + domain, host + path) so logs
//! stay debuggable without leaking the secret payload.

use memry_desktop_tauri_lib::auth::redaction::{
    redact_email, redact_secret, redact_url, sanitize_log_field, RedactionKind,
};

#[test]
fn redact_email_keeps_first_char_and_domain() {
    assert_eq!(redact_email("kaan@example.com"), "k***@example.com");
}

#[test]
fn redact_email_keeps_only_first_char_for_long_local_part() {
    assert_eq!(
        redact_email("kaan94karaca@gmail.com"),
        "k***@gmail.com",
        "long local-parts must collapse to first char + ***",
    );
}

#[test]
fn redact_email_for_single_char_local_part() {
    assert_eq!(redact_email("a@example.com"), "a***@example.com");
}

#[test]
fn redact_email_returns_constant_for_invalid_input() {
    assert_eq!(redact_email("not-an-email"), "<redacted:email>");
    assert_eq!(redact_email(""), "<redacted:email>");
    assert_eq!(redact_email("@example.com"), "<redacted:email>");
    assert_eq!(redact_email("kaan@"), "<redacted:email>");
}

#[test]
fn redact_email_handles_unicode_first_char_without_panic() {
    let out = redact_email("évery@example.com");
    assert!(
        out.starts_with('é') && out.ends_with("@example.com"),
        "redacted email must keep the unicode first char and domain; got {out}",
    );
    assert!(
        !out.contains("very"),
        "redacted email must drop the rest of the local part; got {out}",
    );
}

#[test]
fn redact_url_drops_query_params_but_keeps_host_and_path() {
    let out = redact_url("https://api.example.com/auth/otp/verify?token=secret&device=42");
    assert!(
        out.starts_with("https://api.example.com/auth/otp/verify"),
        "redacted url must keep scheme/host/path; got {out}",
    );
    assert!(
        !out.contains("token=secret"),
        "redacted url must not echo query params; got {out}",
    );
    assert!(
        !out.contains("device=42"),
        "redacted url must not echo query params; got {out}",
    );
    assert!(
        !out.contains("secret"),
        "redacted url must not contain query value; got {out}",
    );
}

#[test]
fn redact_url_marks_redaction_with_redacted_query_marker() {
    let out = redact_url("https://api.example.com/foo?a=1&b=2");
    assert!(
        out.contains("?<redacted>") || out.ends_with("/foo"),
        "url with query params must end with ?<redacted> marker or be stripped; got {out}",
    );
}

#[test]
fn redact_url_passes_through_url_without_query() {
    let out = redact_url("https://api.example.com/auth/otp/verify");
    assert_eq!(out, "https://api.example.com/auth/otp/verify");
}

#[test]
fn redact_url_returns_constant_for_invalid_input() {
    assert_eq!(redact_url("not a url"), "<redacted:url>");
    assert_eq!(redact_url(""), "<redacted:url>");
}

#[test]
fn redact_secret_returns_canonical_constant() {
    assert_eq!(redact_secret("sk-test-1234567890ABCD"), "<redacted:secret>");
    assert_eq!(redact_secret(""), "<redacted:secret>");
    assert_eq!(redact_secret("anything"), "<redacted:secret>");
}

#[test]
fn sanitize_log_field_email_uses_email_redaction() {
    let out = sanitize_log_field(RedactionKind::Email, "kaan@example.com");
    assert_eq!(out, "k***@example.com");
}

#[test]
fn sanitize_log_field_url_uses_url_redaction() {
    let out = sanitize_log_field(
        RedactionKind::Url,
        "https://api.example.com/auth?token=abc",
    );
    assert!(
        !out.contains("token=abc"),
        "url sanitisation must drop query; got {out}",
    );
    assert!(
        out.starts_with("https://api.example.com/auth"),
        "url sanitisation must keep scheme/host/path; got {out}",
    );
}

#[test]
fn sanitize_log_field_provider_key_redacts_to_canonical_marker() {
    let raw = "sk-test-1234567890ABCD";
    let out = sanitize_log_field(RedactionKind::ProviderKey, raw);
    assert_eq!(out, "<redacted:provider-key>");
    assert!(
        !out.contains(raw),
        "provider key sanitisation must not echo raw bytes",
    );
}

#[test]
fn sanitize_log_field_bearer_token_redacts_to_canonical_marker() {
    let token = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
    let out = sanitize_log_field(RedactionKind::BearerToken, token);
    assert_eq!(out, "<redacted:token>");
    assert!(
        !out.contains("eyJhbGciOiJIUzI1NiJ9"),
        "bearer token sanitisation must not echo any segment",
    );
}

#[test]
fn sanitize_log_field_note_title_redacts_to_canonical_marker() {
    let title = "Acquisition deal terms with Acme";
    let out = sanitize_log_field(RedactionKind::NoteTitle, title);
    assert_eq!(out, "<redacted:title>");
    assert!(
        !out.contains("Acme"),
        "note title sanitisation must not echo title content",
    );
}

#[test]
fn sanitize_log_field_provider_key_drops_input_even_if_short() {
    let out = sanitize_log_field(RedactionKind::ProviderKey, "a");
    assert_eq!(out, "<redacted:provider-key>");
}
