//! The browser extension's capture server (Step 27, #3544): Electron's
//! `apps/desktop/src/main/capture/server.ts` on axum. A shipped contract: the extension
//! (`apps/extension/src/lib/capture-client.ts`) and this app update on separate schedules, so
//! routes, status codes, error codes, headers, the port range and the body limit stay as
//! Electron ships them.
//!
//! It binds `127.0.0.1` only, on the first free port of [`DEFAULT_PORT`]..+[`PROBE_RANGE`], and
//! is app-scoped: it survives vault switches and answers `503 vault-closed` while no vault is
//! open. The shell stops it with its `stop-capture-server` shutdown step. `routes` decides every
//! request; `pairing` owns the token and the allowlist; `ingest` stores what a capture carries
//! and hands the row to the inbox owner (`memry_core::api::inbox::Inbox`).

pub mod auth;
pub mod folders;
pub mod ingest;
pub mod pairing;
mod routes;
pub mod schema;

use std::convert::Infallible;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use futures_util::future::BoxFuture;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use memry_core::seams::secure_store::SecureStore;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

use self::pairing::Pairing;
use crate::session::{OpenVault, Session};
use crate::telemetry::service::Service;

/// `server.ts:27-28`: ports 7849 to 7856.
pub const DEFAULT_PORT: u16 = 7849;
pub const PROBE_RANGE: u16 = 8;
/// `server.ts:49`: a larger `/capture` body is `413 payload-too-large`.
pub const BODY_LIMIT: usize = 25 * 1024 * 1024;

/// Asks the user whether `origin` may pair (`showPairConsentDialog`); `true` is Allow. Called
/// on a blocking thread, once per origin at a time.
pub type Consent = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Downloads a capture's hero image into `dir` and returns the file name (`downloadImage`).
pub trait HeroDownload: Send + Sync {
    fn download<'a>(&'a self, url: &'a str, dir: &'a Path) -> BoxFuture<'a, Option<String>>;
}

/// Files a captured item into `folder` of the open vault (`fileToFolder`). Blocking.
pub trait CaptureFiler: Send + Sync {
    fn file(&self, open: &OpenVault, item_id: &str, folder: &str) -> Result<(), String>;
}

pub struct CaptureDeps {
    pub session: Session,
    /// The keychain the vault's `Inbox` needs (`Vault::inbox`).
    pub store: Arc<dyn SecureStore>,
    pub pairing: Arc<Pairing>,
    pub consent: Consent,
    /// `/ping`'s `version`.
    pub version: String,
    /// `None` until the web fetch client (#5048) is wired: a capture then keeps its
    /// `heroImage` URL in metadata and gets no thumbnail.
    pub hero: Option<Arc<dyn HeroDownload>>,
    /// `None` until the inbox filing service lands (Step 27 stage 6): a capture sent to a
    /// folder then stays in the Inbox (`filedTo: null`, reason `file-failed`).
    pub filer: Option<Arc<dyn CaptureFiler>>,
    pub telemetry: Option<Arc<Service>>,
}

/// How long a client may take and how many connections are served at once.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// A connection that has not sent a whole request head in this time is closed (Node's
    /// `headersTimeout`, which Electron's server keeps).
    pub header_read: Duration,
    /// The whole request, body included, arrives within this or the answer is `408` (Node's
    /// `requestTimeout`).
    pub request: Duration,
    /// Connections served at once; the next ones wait in the listen backlog.
    pub connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header_read: Duration::from_secs(60),
            request: Duration::from_secs(300),
            connections: 32,
        }
    }
}

/// A running server. Dropping it stops listening and closes every connection it serves.
pub struct CaptureServer {
    port: u16,
    task: JoinHandle<()>,
}

impl CaptureServer {
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for CaptureServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Binds the first free port of the extension's range and serves. Call inside a tokio runtime.
pub async fn start(deps: CaptureDeps) -> io::Result<CaptureServer> {
    start_in(deps, Limits::default(), DEFAULT_PORT, PROBE_RANGE).await
}

/// [`start`] over `count` ports from `first`. A port in use (or one the OS reserves, which
/// Windows reports as access denied) moves to the next; any other bind error stops.
pub async fn start_in(
    deps: CaptureDeps,
    limits: Limits,
    first: u16,
    count: u16,
) -> io::Result<CaptureServer> {
    for port in (0..count).filter_map(|i| first.checked_add(i)) {
        match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await {
            Ok(listener) => return serve(deps, limits, listener),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        "no free capture port in probe range",
    ))
}

fn serve(deps: CaptureDeps, limits: Limits, listener: TcpListener) -> io::Result<CaptureServer> {
    let port = listener.local_addr()?.port();
    let shared = Arc::new(routes::Shared {
        deps,
        port,
        request_timeout: limits.request,
    });
    let task = tokio::spawn(accept(listener, shared, limits));
    tracing::info!(scope = "Capture", "capture server on 127.0.0.1:{port}");
    Ok(CaptureServer { port, task })
}

/// Serves each connection on its own task, at most `limits.connections` at once. The tasks
/// live in a `JoinSet` this loop owns, so aborting the loop (dropping the server) aborts them.
async fn accept(listener: TcpListener, shared: Arc<routes::Shared>, limits: Limits) {
    let slots = Arc::new(Semaphore::new(limits.connections));
    let mut connections = JoinSet::new();
    let mut http = http1::Builder::new();
    http.timer(TokioTimer::new())
        .header_read_timeout(limits.header_read);
    loop {
        while connections.try_join_next().is_some() {}
        let slot = slots
            .clone()
            .acquire_owned()
            .await
            .expect("the slots are never closed");
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                // Out of file descriptors and the like: wait for some to free up instead of
                // spinning on the error, as `axum::serve` does.
                tracing::warn!(scope = "Capture", "capture server accept failed: {error}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let shared = shared.clone();
        let service = service_fn(move |request: hyper::Request<_>| {
            let shared = shared.clone();
            async move { Ok::<_, Infallible>(routes::handle(&shared, request.map(Body::new)).await) }
        });
        let connection = http.serve_connection(TokioIo::new(stream), service);
        connections.spawn(async move {
            if let Err(error) = connection.await {
                tracing::debug!(scope = "Capture", "capture connection ended: {error}");
            }
            drop(slot);
        });
    }
}
