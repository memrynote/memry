//! The desktop `Transport`: HTTP and the realtime socket over one rustls stack with the sync
//! host's certificate pins enforced (`seams::tls`).
//!
//! It is deliberately dumb, like the core's seam says: one request in, status, headers and bytes
//! out, no retry and no status logic. A non-2xx status is a response, never an error. It serves
//! memry hosts only (`memrynote.com` and its subdomains, over `https`/`wss`), plus the loopback
//! hosts of a development or e2e sync server; a request to any other host is refused before it
//! leaves, and so is a redirect to one. A development server on another machine of the LAN is
//! refused too: point the app at it through a loopback tunnel. Every other HTTP client in the app
//! is `memry_desktop::http::client()`, which this does not replace.
//!
//! - **Redirects** are followed only inside those hosts. A redirect to a memry subdomain with no
//!   pin entry (the docs or the landing site) reaches it over standard TLS, and a 307 or 308 sends
//!   the body there again; the sync server never answers with one.
//! - **Proxies.** HTTP requests use the system proxy (as Electron's session did); the WebSocket
//!   connects directly, because tokio-tungstenite has no proxy support. A network that allows the
//!   sync host only through a proxy gets requests and no realtime socket, and sync falls back to
//!   its pull timer.

mod classify;
mod http;
mod socket;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use rustls::ClientConfig;
use url::Url;

use super::tls::{PinFailure, PinFailureSink, TlsSetup};

pub use http::MAX_RESPONSE_BYTES;
pub use socket::{CONNECT_TIMEOUT, MAX_FRAME_BYTES};

const CONNECT_TIMEOUT_HTTP: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 10;
/// The prefix of the `Failed` text of a refused host, which the tests and logs match.
pub const HOST_NOT_ALLOWED: &str = "host not allowed";

/// Which hosts the transport may talk to.
#[derive(Debug, Clone, Default)]
struct HostPolicy {
    /// Exact hosts that may also use `http`/`ws` (a local test server).
    extra: Vec<String>,
}

impl HostPolicy {
    fn check(&self, url: &Url) -> Result<(), TransportError> {
        let refuse = |what: String| TransportError::Failed { what };
        let host = url
            .host_str()
            .map(|host| host.to_ascii_lowercase())
            .ok_or_else(|| refuse(format!("{HOST_NOT_ALLOWED}: {url} has no host")))?;
        let host = host.trim_end_matches('.');
        let secure = matches!(url.scheme(), "https" | "wss");
        let plain = matches!(url.scheme(), "http" | "ws");
        if self.extra.iter().any(|extra| extra == host) && (secure || plain) {
            return Ok(());
        }
        let memry = host == "memrynote.com" || host.ends_with(".memrynote.com");
        if !memry {
            return Err(refuse(format!("{HOST_NOT_ALLOWED}: {host}")));
        }
        if !secure {
            return Err(refuse(format!(
                "{HOST_NOT_ALLOWED}: {host} is only reached over a secure scheme"
            )));
        }
        Ok(())
    }

    fn check_str(&self, url: &str) -> Result<(), TransportError> {
        let parsed = Url::parse(url).map_err(|error| TransportError::Failed {
            what: format!("unusable url `{url}`: {error}"),
        })?;
        self.check(&parsed)
    }
}

/// The app's one transport to the sync server, as managed state: telemetry, log shipping,
/// feedback and incident reports, then sync (Step 17, #3534).
pub type SyncTransport = Arc<dyn Transport>;

/// The pinned transport over the memry hosts and `loopback_hosts`. When the TLS stack cannot
/// start, the app still opens (local first) and every send fails with the reason.
pub fn app_transport(loopback_hosts: &[String], sink: Arc<dyn PinFailureSink>) -> SyncTransport {
    let hosts: Vec<&str> = loopback_hosts.iter().map(String::as_str).collect();
    match NativeTransport::with_extra_hosts(sink, &hosts) {
        Ok(transport) => Arc::new(transport),
        Err(error) => {
            tracing::error!(
                scope = "Transport",
                "the sync transport could not start; nothing reaches the server this run: {error}"
            );
            Arc::new(Unavailable(error.to_string()))
        }
    }
}

struct Unavailable(String);

#[async_trait::async_trait]
impl Transport for Unavailable {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        Err(TransportError::Failed {
            what: self.0.clone(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: self.0.clone(),
        })
    }
}

/// A pin mismatch ends the sync socket until the app restarts (`websocket.ts`
/// `certificate_pin_failed` stops reconnecting): the latch is set here, then the sink hears it.
struct LatchingSink {
    latched: Arc<AtomicBool>,
    inner: Arc<dyn PinFailureSink>,
}

impl PinFailureSink for LatchingSink {
    fn pin_failed(&self, failure: PinFailure) {
        self.latched.store(true, Ordering::Release);
        self.inner.pin_failed(failure);
    }
}

pub struct NativeTransport {
    http: reqwest::Client,
    no_redirect: reqwest::Client,
    socket_tls: Arc<ClientConfig>,
    hosts: Arc<HostPolicy>,
    pin_latched: Arc<AtomicBool>,
}

impl NativeTransport {
    /// The OS trust store and the production pin table (pinning is active in a release build).
    pub fn new(sink: Arc<dyn PinFailureSink>) -> Result<Self, TransportError> {
        Self::with_setup(TlsSetup::platform()?, sink, &[])
    }

    /// A transport that also serves these exact hosts, over any scheme: the local sync server of a
    /// development or e2e build ([`crate::config::RuntimeConfig::loopback_hosts`]), or of a test.
    pub fn with_extra_hosts(
        sink: Arc<dyn PinFailureSink>,
        hosts: &[&str],
    ) -> Result<Self, TransportError> {
        Self::with_setup(TlsSetup::platform()?, sink, hosts)
    }

    /// The same over a loopback server, with no pin sink. For the tests of other modules.
    #[doc(hidden)]
    pub fn loopback() -> Arc<dyn Transport> {
        struct Quiet;
        impl PinFailureSink for Quiet {
            fn pin_failed(&self, _failure: PinFailure) {}
        }
        Arc::new(
            Self::with_extra_hosts(Arc::new(Quiet), &["127.0.0.1", "localhost"])
                .expect("the platform certificate verifier starts"),
        )
    }

    #[doc(hidden)]
    pub fn with_setup(
        setup: TlsSetup,
        sink: Arc<dyn PinFailureSink>,
        extra_hosts: &[&str],
    ) -> Result<Self, TransportError> {
        let pin_latched = Arc::new(AtomicBool::new(false));
        let sink = Arc::new(LatchingSink {
            latched: pin_latched.clone(),
            inner: sink,
        });
        let mut tls = setup.client_config(sink)?;
        let hosts = Arc::new(HostPolicy {
            extra: extra_hosts
                .iter()
                .map(|host| host.to_ascii_lowercase())
                .collect(),
        });

        // The socket speaks HTTP/1.1 only; HTTP gets h2.
        let mut socket_tls = tls.clone();
        socket_tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

        let client = |policy: reqwest::redirect::Policy| {
            let mut builder = reqwest::Client::builder()
                .tls_backend_preconfigured(tls.clone())
                .connect_timeout(CONNECT_TIMEOUT_HTTP)
                .user_agent(concat!("MemryNote/", env!("CARGO_PKG_VERSION")))
                .redirect(policy);
            if !hosts.extra.is_empty() {
                builder = builder.no_proxy();
            }
            builder.build().map_err(|error| TransportError::Failed {
                what: format!("could not build the HTTP client: {error}"),
            })
        };
        let redirect_hosts = hosts.clone();
        let following = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if redirect_hosts.check(attempt.url()).is_ok() {
                attempt.follow()
            } else {
                // Hand the 3xx back as a response rather than follow it off the allowed hosts.
                attempt.stop()
            }
        });
        Ok(Self {
            http: client(following)?,
            no_redirect: client(reqwest::redirect::Policy::none())?,
            socket_tls: Arc::new(socket_tls),
            hosts,
            pin_latched,
        })
    }

    /// Like `send` but a 3xx is returned as a response with its `location` header, never followed
    /// (the OAuth init request, Step 19 (#3536)).
    pub async fn send_no_redirect(
        &self,
        request: HttpRequest,
    ) -> Result<HttpResponse, TransportError> {
        self.hosts.check_str(&request.url)?;
        http::send(&self.no_redirect, request).await
    }

    /// Whether a pin mismatch has ended the socket for this run.
    pub fn socket_blocked_by_pin(&self) -> bool {
        self.pin_latched.load(Ordering::Acquire)
    }
}

#[async_trait::async_trait]
impl Transport for NativeTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.hosts.check_str(&request.url)?;
        http::send(&self.http, request).await
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        if self.socket_blocked_by_pin() {
            return Err(TransportError::Tls {
                what: "certificate pin mismatch earlier in this run".to_owned(),
            });
        }
        self.hosts.check_str(&request.url)?;
        let wire = socket::wire_request(&request)?;
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| TransportError::Failed {
                what: "no async runtime to run the socket on".to_owned(),
            })?;
        Ok(socket::open(
            &runtime,
            wire,
            listener,
            self.socket_tls.clone(),
        ))
    }
}
