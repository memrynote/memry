//! The production [`Fetcher`] of article extraction: the Defuddle extractors' `this.fetch` over
//! the web client. Extraction is synchronous and runs inside `spawn_blocking`, so each request
//! blocks that thread on the async client through a runtime handle captured before the call.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::runtime::Handle;
use wreq::Method;
use wreq::header::{CONTENT_TYPE, HeaderName, HeaderValue};

use super::{WebFetch, decode_text, header_text, read_capped, send, within};
use crate::web::extract::fetch::{FetchRequest, FetchResponse, Fetcher};

pub struct BlockingFetcher {
    web: WebFetch,
    handle: Handle,
    /// Set once the caller stopped waiting for the extraction; every later request is refused.
    abandoned: Arc<AtomicBool>,
}

impl BlockingFetcher {
    /// `handle` must not be the runtime of the calling thread's task: [`Fetcher::fetch`] blocks
    /// on it, which panics inside an async context. Call `fetch` from `spawn_blocking`.
    pub fn new(web: WebFetch, handle: Handle, abandoned: Arc<AtomicBool>) -> Self {
        Self {
            web,
            handle,
            abandoned,
        }
    }
}

impl Fetcher for BlockingFetcher {
    /// The page deadline and HTML cap apply to every request. The error string never carries the
    /// URL; Defuddle logs it and continues without the async extractor.
    fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, String> {
        if self.abandoned.load(Ordering::SeqCst) {
            return Err("The extraction was abandoned".to_owned());
        }
        let method = Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "Invalid request method".to_owned())?;
        let mut builder = self.web.client.request(method, request.url.as_str());
        for (name, value) in &request.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid request header".to_owned())?;
            let value =
                HeaderValue::from_str(value).map_err(|_| "Invalid request header".to_owned())?;
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let limits = self.web.limits;
        self.handle
            .block_on(within(limits.page_timeout, async move {
                let response = send(builder).await?;
                let status = response.status();
                let content_type = header_text(&response, CONTENT_TYPE);
                let body = read_capped(response, limits.max_html_bytes).await?;
                Ok(FetchResponse {
                    status: status.as_u16(),
                    ok: status.is_success(),
                    text: decode_text(&body, content_type.as_deref()),
                })
            }))
            .map_err(|error| error.to_string())
    }
}
