//! The loopback media server: audio and video bytes with Range, and the YouTube embed page.
//!
//! The engine's custom schemes buffer a response in memory, so a long video cannot play through
//! `memry-file://`. This server streams the same files, through the same `serve_file`, from
//! `127.0.0.1` on a random port. What a request may ask for, and who may ask, is decided by
//! `loopback_route` (host, token, path); this module only moves bytes.

use std::io::{self, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::body::Body as HttpBody;
use axum::extract::State;
use axum::http::{HeaderValue, Method, Request, Response, StatusCode, header};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::io::ReaderStream;

use super::file_serve::{CHUNK_SIZE, FRAME_PERMISSIONS_POLICY};
use super::file_service::{Body, Caps, FileRequest, Roots, Served, serve_file};
use super::loopback_route::{EMBED_CSP, Route, route, youtube_embed_html};

type RootsFn = dyn Fn() -> Roots + Send + Sync;

#[derive(Clone)]
struct Shared {
    port: u16,
    token: Arc<str>,
    roots: Arc<RootsFn>,
    windows: bool,
}

/// A running server. Dropping it stops it.
pub struct LoopbackServer {
    port: u16,
    token: String,
    task: JoinHandle<()>,
}

impl LoopbackServer {
    /// `http://127.0.0.1:<port>`: what the renderer prefixes its routes with.
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for LoopbackServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 244 random bits as hex: two version-4 UUIDs (122 random bits each), which draw from the OS
/// random source.
fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Binds `127.0.0.1:0` and serves until the handle drops. Call inside a tokio runtime.
pub async fn start(roots: Arc<RootsFn>, windows: bool) -> io::Result<LoopbackServer> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let port = listener.local_addr()?.port();
    let token = new_token();
    let state = Shared {
        port,
        token: Arc::from(token.as_str()),
        roots,
        windows,
    };
    let app = Router::new().fallback(handle).with_state(state);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(scope = "Loopback", "the media server stopped: {error}");
        }
    });
    Ok(LoopbackServer { port, token, task })
}

fn plain(status: StatusCode) -> Response<HttpBody> {
    let mut response = Response::new(HttpBody::empty());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn handle(State(state): State<Shared>, request: Request<HttpBody>) -> Response<HttpBody> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    let decided = route(host, request.uri().path(), state.port, &state.token);
    let get = request.method() == Method::GET;
    match decided {
        Route::BadHost => plain(StatusCode::FORBIDDEN),
        Route::NotFound => plain(StatusCode::NOT_FOUND),
        _ if !get => plain(StatusCode::METHOD_NOT_ALLOWED),
        Route::YoutubeEmbed(id) => embed_page(&id),
        Route::Media(url) => {
            let asked = asked_headers(request.headers());
            media(&state, url, asked).await
        }
    }
}

fn embed_page(video_id: &str) -> Response<HttpBody> {
    let mut response = Response::new(HttpBody::from(youtube_embed_html(video_id)));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(EMBED_CSP),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(FRAME_PERMISSIONS_POLICY),
    );
    response
}

fn asked_headers(headers: &header::HeaderMap) -> Asked {
    let text = |name: header::HeaderName| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    Asked {
        range: text(header::RANGE),
        origin: text(header::ORIGIN),
        fetch_dest: text(header::HeaderName::from_static("sec-fetch-dest")),
    }
}

/// The request headers `serve_file` decides on, owned for the blocking thread.
struct Asked {
    range: Option<String>,
    origin: Option<String>,
    fetch_dest: Option<String>,
}

async fn media(state: &Shared, url: String, asked: Asked) -> Response<HttpBody> {
    let roots = (state.roots)();
    let windows = state.windows;
    let served = tokio::task::spawn_blocking(move || {
        let request = FileRequest {
            range: asked.range.as_deref(),
            origin: asked.origin.as_deref(),
            fetch_dest: asked.fetch_dest.as_deref(),
            // The loopback route is gated by its own URL token.
            required_token: None,
        };
        let mut served = serve_file(&url, &request, &roots, windows, Caps::UNBOUNDED);
        // Position the file here, off the async threads, so the stream only reads.
        if let Body::File { file, start, .. } = &mut served.body
            && let Err(error) = file.seek(SeekFrom::Start(*start))
        {
            served = Served {
                failure: Some(format!("{:?}", error.kind())),
                ..Served::not_found()
            };
        }
        served
    })
    .await;
    let Ok(served) = served else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR);
    };
    into_response(served)
}

fn into_response(served: Served) -> Response<HttpBody> {
    let Served {
        status,
        headers,
        body,
        failure,
    } = served;
    if let Some(code) = failure {
        tracing::warn!(scope = "Loopback", code, "serve failed");
    }
    let body = match body {
        Body::Empty => HttpBody::empty(),
        Body::Bytes(bytes) => HttpBody::from(bytes),
        Body::File { file, len, .. } => stream(file, len),
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND);
    let out = response.headers_mut();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            out.insert(name, value);
        }
    }
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `len` bytes of `file`, already positioned, in [`CHUNK_SIZE`] reads and never all in memory.
fn stream(file: std::fs::File, len: u64) -> HttpBody {
    let reader = tokio::fs::File::from_std(file).take(len);
    HttpBody::from_stream(ReaderStream::with_capacity(reader, CHUNK_SIZE))
}

#[cfg(test)]
mod tests;
