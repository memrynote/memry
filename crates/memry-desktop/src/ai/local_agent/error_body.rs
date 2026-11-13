//! The message of a failed step request, from its status and error body.

use serde_json::Value;

use crate::ai::local_provider::LocalProvider;

/// `withResponseReason` clips the server's reason to this many characters.
const REASON_CLIP: usize = 500;

/// The message of a failed provider call (`errorMessage` with `withResponseReason`): an
/// OpenAI-style `{error: {message}}` body gives the message; otherwise the status text, with the
/// server's own reason (`{error: "..."}` or a non-JSON body) after it. `text` is redacted raw;
/// a parsed reason is redacted again before the clip, as parsing can unescape a key (`\/`).
pub(super) fn http_error(
    status: reqwest::StatusCode,
    text: &str,
    provider: &LocalProvider,
) -> String {
    let parsed = serde_json::from_str::<Value>(text.trim()).ok();
    if let Some(message) = parsed
        .as_ref()
        .and_then(|body| body["error"]["message"].as_str())
    {
        return provider.redact(message.to_owned());
    }
    let status_text = status
        .canonical_reason()
        .map_or_else(|| format!("HTTP {}", status.as_u16()), str::to_owned);
    let reason = match &parsed {
        Some(body) => body["error"]
            .as_str()
            .map(|r| provider.redact(r.to_owned())),
        None => Some(text.trim().to_owned()),
    };
    match reason.filter(|reason| !reason.is_empty()) {
        Some(reason) => {
            let clipped: String = reason.chars().take(REASON_CLIP).collect();
            let clipped = if clipped.len() < reason.len() {
                format!("{clipped}...")
            } else {
                clipped
            };
            format!("{status_text}: {clipped}")
        }
        None => status_text,
    }
}

#[cfg(test)]
mod tests {
    use reqwest::StatusCode;

    use crate::ai::local_provider::{AgentLocalProviderPreset, AgentLocalThinking, LocalProvider};

    fn http_error(status: StatusCode, text: &str) -> String {
        let preset = AgentLocalProviderPreset::Custom;
        let provider = LocalProvider {
            preset,
            base_url: preset.default_base_url().to_owned(),
            model: String::new(),
            allow_non_loopback: false,
            thinking: AgentLocalThinking::Default,
            api_key: None,
        };
        super::http_error(status, text, &provider)
    }

    #[test]
    fn the_server_reason_follows_the_status_text() {
        let bad = StatusCode::BAD_REQUEST;
        assert_eq!(
            http_error(
                bad,
                r#"{"error":{"message":"tool_choice is not supported"}}"#
            ),
            "tool_choice is not supported"
        );
        assert_eq!(
            http_error(bad, r#"{"error":"gemma does not support tools"}"#),
            "Bad Request: gemma does not support tools"
        );
        assert_eq!(http_error(bad, "plain"), "Bad Request: plain");
        assert_eq!(http_error(bad, ""), "Bad Request");
    }
}
