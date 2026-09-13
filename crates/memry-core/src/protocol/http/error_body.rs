//! The error envelope, chapter 00 §0.4.

use serde_json::Value as Json;

/// The parsed error envelope, chapter 00 §0.4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorBody {
    pub code: Option<String>,
    pub message: String,
    /// Rides **inside** the `error` object, chapter 11 §11.6.
    pub min_version: Option<String>,
}

/// Parses the three shapes chapter 00 §0.4 requires a client to tolerate:
/// `{"error":{"code","message"}}`, `{"error":"some message"}`, and anything
/// else, which degrades to `HTTP <status>`.
pub fn parse_error_body(status: u16, body: &[u8]) -> ErrorBody {
    let fallback = || ErrorBody {
        code: None,
        message: format!("HTTP {status}"),
        min_version: None,
    };
    let Ok(json) = serde_json::from_slice::<Json>(body) else {
        return fallback();
    };
    let Some(error) = json.get("error") else {
        return fallback();
    };
    if let Some(message) = error.as_str() {
        return ErrorBody {
            code: None,
            message: message.to_string(),
            min_version: None,
        };
    }
    let Some(object) = error.as_object() else {
        return fallback();
    };
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Json::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    ErrorBody {
        code: string("code"),
        message: string("message").unwrap_or_else(|| format!("HTTP {status}")),
        min_version: string("minVersion"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_object_error_shape_parses() {
        let body = br#"{"error":{"code":"SYNC_INVALID_SIGNATURE","message":"nope"}}"#;
        let parsed = parse_error_body(403, body);
        assert_eq!(parsed.code.as_deref(), Some("SYNC_INVALID_SIGNATURE"));
        assert_eq!(parsed.message, "nope");
    }
    #[test]
    fn the_bare_string_error_shape_parses() {
        let parsed = parse_error_body(400, br#"{"error":"Invalid cursor"}"#);
        assert_eq!(parsed.code, None);
        assert_eq!(parsed.message, "Invalid cursor");
    }
    #[test]
    fn min_version_is_read_from_inside_the_error_object() {
        let body =
            br#"{"error":{"code":"CLIENT_UPGRADE_REQUIRED","message":"old","minVersion":"2.0.0"}}"#;
        let parsed = parse_error_body(426, body);
        assert_eq!(parsed.min_version.as_deref(), Some("2.0.0"));
    }
    #[test]
    fn a_non_json_body_degrades_to_the_status() {
        assert_eq!(
            parse_error_body(503, b"<html>502</html>").message,
            "HTTP 503"
        );
        assert_eq!(parse_error_body(500, b"").message, "HTTP 500");
        assert_eq!(parse_error_body(404, br#"{"nope":1}"#).message, "HTTP 404");
    }
}
