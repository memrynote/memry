//! The reply cut, the port of Electron's `agent/mcp/reply-cap.ts`. A reply whose JSON is over the
//! cap becomes `{truncated, totalBytes, message, partial}`, with `partial` the start of the JSON.
//! Sizes are UTF-8 bytes; the cut point counts UTF-16 units, as `String.slice` does, and never
//! ends on a high surrogate.

use serde::Serialize;
use serde_json::Value;

/// The cap a tool's reply is held to, and what to tell the agent when it is cut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyCap {
    pub max_bytes: usize,
    pub advice: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TruncatedReply {
    truncated: bool,
    total_bytes: usize,
    message: String,
    partial: String,
}

pub fn cap_reply(value: Value, cap: &ReplyCap) -> Value {
    let text = value.to_string();
    let total_bytes = text.len();
    if total_bytes <= cap.max_bytes {
        return value;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut end = units.len().min(cap.max_bytes);
    let mut reply = truncated(&units, total_bytes, end, &cap.advice);
    let mut reply_bytes = reply_len(&reply);
    // `partial` is escaped again when the reply is serialized, so the cut shrinks until the
    // whole serialized reply fits.
    while reply_bytes > cap.max_bytes && end > 0 {
        end = (end - 1).min(end * cap.max_bytes / reply_bytes);
        reply = truncated(&units, total_bytes, end, &cap.advice);
        reply_bytes = reply_len(&reply);
    }
    serde_json::to_value(reply).unwrap_or(Value::Null)
}

fn truncated(units: &[u16], total_bytes: usize, end: usize, advice: &str) -> TruncatedReply {
    let ends_high = end > 0 && (0xD800..=0xDBFF).contains(&units[end - 1]);
    let partial = String::from_utf16_lossy(&units[..if ends_high { end - 1 } else { end }]);
    TruncatedReply {
        truncated: true,
        total_bytes,
        message: format!(
            "Reply cut at {} of {total_bytes} bytes. partial holds the start of the JSON reply and \
             is not valid JSON on its own. The rest is not returned. {advice}",
            partial.len()
        ),
        partial,
    }
}

fn reply_len(reply: &TruncatedReply) -> usize {
    serde_json::to_string(reply).map_or(usize::MAX, |text| text.len())
}
