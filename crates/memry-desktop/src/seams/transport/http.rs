//! One HTTP request and its response. No retry, no auth, no status logic: the core owns them.

use std::collections::HashMap;
use std::time::Duration;

use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{HttpRequest, HttpResponse};

use super::classify::http_failure;

/// The largest response body read. The server's largest answer is a pack of at most 32 MiB.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

pub async fn send(
    client: &reqwest::Client,
    request: HttpRequest,
) -> Result<HttpResponse, TransportError> {
    let timeout_ms = request.timeout_ms;
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|error| {
        TransportError::Failed {
            what: format!("unusable method `{}`: {error}", request.method),
        }
    })?;
    // No client-wide timeout: the ceiling is per request and the core chose it. It covers the
    // body too, so a body that stalls ends as `Timeout`.
    let mut wire = client
        .request(method, &request.url)
        .timeout(Duration::from_millis(timeout_ms));
    for (name, value) in &request.headers {
        wire = wire.header(name, value);
    }
    if let Some(body) = request.body {
        wire = wire.body(body);
    }

    let mut response = wire
        .send()
        .await
        .map_err(|error| http_failure(&error, timeout_ms))?;
    let status = response.status().as_u16();
    // Lowercase keys, as the seam requires. A header sent more than once keeps every value, joined
    // with ", " in the order received (RFC 9110 §5.3; the seam's map has one value per name). A
    // value that is not UTF-8 is dropped rather than rewritten: no header the protocol reads is
    // binary.
    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers() {
        let Ok(value) = value.to_str() else { continue };
        headers
            .entry(name.as_str().to_ascii_lowercase())
            .and_modify(|joined| {
                joined.push_str(", ");
                joined.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }
    let too_large = || TransportError::Failed {
        what: format!("the response body is larger than {MAX_RESPONSE_BYTES} bytes"),
    };
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| http_failure(&error, timeout_ms))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}
