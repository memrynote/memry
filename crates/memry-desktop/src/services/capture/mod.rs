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

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

use axum::Router;
use futures_util::future::BoxFuture;
use memry_core::seams::secure_store::SecureStore;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

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

/// A running server. Dropping it stops listening at once; requests already accepted finish.
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
    start_in(deps, DEFAULT_PORT, PROBE_RANGE).await
}

/// [`start`] over `count` ports from `first`. A port in use (or one the OS reserves, which
/// Windows reports as access denied) moves to the next; any other bind error stops.
pub async fn start_in(deps: CaptureDeps, first: u16, count: u16) -> io::Result<CaptureServer> {
    for port in (0..count).filter_map(|i| first.checked_add(i)) {
        match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await {
            Ok(listener) => return serve(deps, listener),
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

fn serve(deps: CaptureDeps, listener: TcpListener) -> io::Result<CaptureServer> {
    let port = listener.local_addr()?.port();
    let shared = Arc::new(routes::Shared { deps, port });
    let app = Router::new().fallback(routes::handle).with_state(shared);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(scope = "Capture", "the capture server stopped: {error}");
        }
    });
    tracing::info!(scope = "Capture", "capture server on 127.0.0.1:{port}");
    Ok(CaptureServer { port, task })
}
