//! The pack GET and its time budget (chapter 00 §0.6, chapter 08 §8.9, #5331).

use crate::protocol::http::{ApiRequest, Auth, DEFAULT_REQUEST_TIMEOUT_MS, HttpClient, RetryPolicy};

use super::PackSummary;

pub fn pack_deadline_ms(_byte_size: Option<u64>) -> u64 {
    DEFAULT_REQUEST_TIMEOUT_MS
}

pub(super) async fn download(http: &HttpClient, pack: &PackSummary) -> Result<Vec<u8>, String> {
    let mut request = ApiRequest::new("GET", &pack.url)
        .auth(Auth::None)
        .retry(RetryPolicy::polled());
    request.timeout_ms = pack_deadline_ms(pack.byte_size);
    http.send(request)
        .await
        .map(|response| response.body)
        .map_err(|error| error.to_string())
}
