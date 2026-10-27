//! User-triggered reports: the incident report (Path B, `diagnostics/incident-report.ts`) and
//! beta feedback. Both go to the sync server through `http::client()`. The incident report is
//! built once, previewed, and the same value is sent, so the user sees what leaves.

use std::collections::HashMap;
use std::time::Duration;

use memry_core::seams::transport::{HttpRequest, Transport};
use serde::{Deserialize, Serialize};

use super::logship::DiagnosticLine;
use super::service::Context;
use crate::redact::{RedactOptions, redact_text};

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STACK_CAP: usize = 4000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticTrigger {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSnapshot {
    pub app_version: String,
    pub build_channel: String,
    pub platform: String,
    pub arch: String,
    pub locale: String,
    pub uptime_seconds: f64,
    pub sync_enabled: bool,
    pub sync_state: String,
    pub queue_depth: u32,
    pub vault_open: bool,
    pub auth_state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub schema_version: u8,
    pub install_id: String,
    pub session_id: String,
    pub app_version: String,
    pub build_channel: String,
    pub platform: String,
    pub arch: String,
    pub incident_id: String,
    pub trigger: DiagnosticTrigger,
    pub snapshot: DiagnosticSnapshot,
    pub lines: Vec<DiagnosticLine>,
}

/// `MEMRY-` and eight characters of an alphabet without look-alikes. The alphabet has 32
/// letters, so masking five bits of a random byte is an unbiased index.
pub fn generate_incident_id() -> String {
    let random = uuid::Uuid::new_v4();
    let id: String = random.as_bytes()[..8]
        .iter()
        .map(|b| char::from(BASE32[usize::from(b & 31)]))
        .collect();
    format!("MEMRY-{id}")
}

/// `^MEMRY-[A-Z0-9]{6,12}$`
pub fn is_incident_id(id: &str) -> bool {
    id.strip_prefix("MEMRY-").is_some_and(|rest| {
        (6..=12).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    })
}

/// Keeps the frame lines of a stack (the header can carry a note title or an error message
/// verbatim), redacts each, and caps the result.
fn redact_stack(stack: Option<&str>, opts: &RedactOptions) -> Option<String> {
    let frames: Vec<String> = stack?
        .lines()
        .filter(|line| {
            line.starts_with(char::is_whitespace) && line.trim_start().starts_with("at ")
        })
        .map(|line| redact_text(line, opts))
        .collect();
    if frames.is_empty() {
        return None;
    }
    Some(frames.join("\n").chars().take(STACK_CAP).collect())
}

pub struct BuildInputs<'a> {
    pub incident_id: String,
    pub context: &'a Context,
    pub snapshot: DiagnosticSnapshot,
    pub recent_lines: Vec<DiagnosticLine>,
    pub opts: &'a RedactOptions<'a>,
}

pub fn build_incident_report(trigger: &DiagnosticTrigger, inputs: BuildInputs) -> DiagnosticReport {
    let stack = redact_stack(trigger.stack.as_deref(), inputs.opts);
    DiagnosticReport {
        schema_version: 1,
        install_id: inputs.context.install_id.clone(),
        session_id: inputs.context.session_id.clone(),
        app_version: inputs.context.app_version.clone(),
        build_channel: inputs.context.build_channel.clone(),
        platform: inputs.context.platform.clone(),
        arch: inputs.context.arch.clone(),
        incident_id: inputs.incident_id,
        trigger: DiagnosticTrigger {
            source: trigger.source.clone(),
            error_code: trigger.error_code.clone(),
            stack,
        },
        snapshot: inputs.snapshot,
        // Already redacted by the ring on ingest: not redacted twice.
        lines: inputs.recent_lines,
    }
}

/// POSTs `body` as JSON through the pinned transport. A non-2xx answer is an error naming only the
/// status.
pub async fn post_json(
    transport: &dyn Transport,
    url: &str,
    body: String,
    bearer: Option<&str>,
) -> Result<(), String> {
    let mut headers = HashMap::from([("content-type".to_owned(), "application/json".to_owned())]);
    if let Some(token) = bearer {
        headers.insert("authorization".to_owned(), format!("Bearer {token}"));
    }
    let response = transport
        .send(HttpRequest {
            method: "POST".to_owned(),
            url: url.to_owned(),
            headers,
            body: Some(body.into_bytes()),
            timeout_ms: u64::try_from(REQUEST_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
        })
        .await
        .map_err(|e| e.to_string())?;
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        Err(format!("status {}", response.status))
    }
}

/// The user's feedback (`FeedbackSubmitSchema`): the message trimmed and 1 to 5000 characters, an
/// optional email that looks like one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmit {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

impl FeedbackSubmit {
    /// The validated, trimmed value, or the error code the renderer shows (`INVALID_FEEDBACK`).
    pub fn validated(self) -> Result<Self, &'static str> {
        let message = self.message.trim().to_owned();
        let email = self.email.map(|e| e.trim().to_owned());
        let bad_email = email.as_deref().is_some_and(|e| {
            e.chars().count() > 320 || e.contains(char::is_whitespace) || !matches!(e.split_once('@'), Some((l, d)) if !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.'))
        });
        let too_long =
            |v: &Option<String>, max| v.as_deref().is_some_and(|s| s.chars().count() > max);
        if message.is_empty()
            || message.chars().count() > 5000
            || bad_email
            || too_long(&self.app_version, 50)
            || too_long(&self.platform, 50)
        {
            return Err("INVALID_FEEDBACK");
        }
        Ok(Self {
            message,
            email,
            app_version: self.app_version,
            platform: self.platform,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> Context {
        Context {
            install_id: "i".into(),
            session_id: "s".into(),
            app_version: "1.0.0".into(),
            build_channel: "production".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            locale: "en".into(),
            timezone_offset_minutes: 0,
        }
    }

    #[test]
    fn incident_ids_have_the_server_shape() {
        for _ in 0..50 {
            assert!(is_incident_id(&generate_incident_id()));
        }
        assert!(
            !is_incident_id("MEMRY-abc123")
                && !is_incident_id("MEMRY-ABC")
                && !is_incident_id("X-ABCDEF")
        );
    }

    #[test]
    fn the_stack_keeps_frames_only_and_redacts_them() {
        let trigger = DiagnosticTrigger {
            source: "renderer".into(),
            error_code: None,
            stack: Some("Error: opening My Secret Note\n    at open (/Users/kaan/app/x.ts:1:2)\n    at run (/Users/kaan/Notes/secret.md:3:4)".into()),
        };
        let ctx = context();
        let opts = RedactOptions::default();
        let snapshot = DiagnosticSnapshot {
            app_version: "1.0.0".into(),
            build_channel: "production".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            locale: "en".into(),
            uptime_seconds: 5.0,
            sync_enabled: false,
            sync_state: "disabled".into(),
            queue_depth: 0,
            vault_open: false,
            auth_state: "anonymous".into(),
        };
        let report = build_incident_report(
            &trigger,
            BuildInputs {
                incident_id: "MEMRY-ABCDEFGH".into(),
                context: &ctx,
                snapshot,
                recent_lines: vec![],
                opts: &opts,
            },
        );
        let stack = report.trigger.stack.expect("stack");
        assert!(
            !stack.contains("My Secret") && !stack.contains("kaan"),
            "{stack}"
        );
        assert_eq!(stack.lines().count(), 2);
    }

    #[test]
    fn feedback_is_trimmed_and_bounded() {
        let ok = FeedbackSubmit {
            message: "  hi  ".into(),
            email: Some(" a@b.co ".into()),
            app_version: None,
            platform: None,
        }
        .validated()
        .expect("ok");
        assert_eq!(
            (ok.message.as_str(), ok.email.as_deref()),
            ("hi", Some("a@b.co"))
        );
        for bad in [
            FeedbackSubmit {
                message: "   ".into(),
                email: None,
                app_version: None,
                platform: None,
            },
            FeedbackSubmit {
                message: "x".repeat(5001),
                email: None,
                app_version: None,
                platform: None,
            },
            FeedbackSubmit {
                message: "hi".into(),
                email: Some("nope".into()),
                app_version: None,
                platform: None,
            },
        ] {
            assert_eq!(bad.validated(), Err("INVALID_FEEDBACK"));
        }
    }
}
