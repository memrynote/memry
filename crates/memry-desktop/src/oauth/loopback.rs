//! The one-shot loopback a browser sign-in returns to (RFC 8252 §7.3): `127.0.0.1` on a port the
//! OS picks, one path, one answer, then gone. Electron's `startLoopbackServer` and its request
//! handler (`apps/desktop/src/main/ipc/auth-oauth-handlers.ts:56-189`); the Google calendar
//! connection (Step 29, #3546) reuses it.
//!
//! The server takes nothing until [`OneShotCallback::expect_state`] names the attempt's `state`:
//! a callback for another state is refused and the wait goes on, so a forged redirect cannot end
//! the user's sign-in. The first callback for the state, a code or the provider's `error`, is the
//! answer; the server then closes, and a later request finds nothing listening. With no answer
//! within the time to live the wait ends as [`CallbackOutcome::Expired`] and the server closes.

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, Method, Request, Response, StatusCode, header};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

pub const CALLBACK_PATH: &str = "/callback";

/// Electron's page for a code that arrived (`auth-oauth-handlers.ts:52-56`), verbatim.
pub const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>memrynote</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#999}</style></head>
<body><div class="c"><h1>Signed in</h1><p>You can close this tab and return to memrynote.</p></div></body></html>"#;

/// Electron's page for a refused or cancelled callback (`auth-oauth-handlers.ts:58-62`), verbatim.
pub const ERROR_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>memrynote</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#999}</style></head>
<body><div class="c"><h1>Authentication failed</h1><p>Authentication was cancelled. You can close this window.</p></div></body></html>"#;

/// How the wait for the browser ended.
#[derive(Clone, PartialEq, Eq)]
pub enum CallbackOutcome {
    /// The provider sent the user back with a code for the expected state.
    Code { code: String, state: String },
    /// The provider sent the user back with `error` (consent declined).
    Denied,
    /// Nothing came back within the time to live.
    Expired,
}

/// Never prints the code or the state.
impl std::fmt::Debug for CallbackOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Code { .. } => f.write_str("Code { <redacted> }"),
            Self::Denied => f.write_str("Denied"),
            Self::Expired => f.write_str("Expired"),
        }
    }
}

struct Shared {
    /// `127.0.0.1:<port>`, the only `Host` served: a page that rebinds a name to the loopback
    /// sends its own.
    host: String,
    expected: Mutex<Option<String>>,
    answer: Mutex<Option<oneshot::Sender<CallbackOutcome>>>,
    answered: Notify,
}

/// A bound loopback waiting for one browser callback. Dropping it closes the server.
pub struct OneShotCallback {
    port: u16,
    shared: Arc<Shared>,
    outcome: oneshot::Receiver<CallbackOutcome>,
    task: JoinHandle<()>,
}

impl OneShotCallback {
    /// Binds `127.0.0.1:0` and serves for at most `ttl`. Call inside a tokio runtime.
    pub async fn bind(ttl: Duration) -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
        let port = listener.local_addr()?.port();
        let deadline = tokio::time::Instant::now() + ttl;
        let (sender, outcome) = oneshot::channel();
        let shared = Arc::new(Shared {
            host: format!("{}:{port}", Ipv4Addr::LOCALHOST),
            expected: Mutex::new(None),
            answer: Mutex::new(Some(sender)),
            answered: Notify::new(),
        });
        let app = Router::new()
            .fallback(handle)
            .with_state(Arc::clone(&shared));
        let server = Arc::clone(&shared);
        let task = tokio::spawn(async move {
            let shutdown = Arc::clone(&server);
            let serve = axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown.answered.notified().await })
                .into_future();
            // The listener is closed before the expiry is reported, so a caller that saw
            // `Expired` finds nothing listening.
            let served = tokio::time::timeout_at(deadline, serve).await;
            if let Ok(Err(error)) = served {
                tracing::warn!(scope = "OAuth", "the sign-in loopback stopped: {error}");
            }
            answer(&server, CallbackOutcome::Expired);
        });
        Ok(Self {
            port,
            shared,
            outcome,
            task,
        })
    }

    /// `http://127.0.0.1:<port>/callback`, the `redirect_uri` the provider sends the user back to.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// The `state` the attempt opened with; until it is set every callback is refused.
    pub fn expect_state(&self, state: &str) {
        *self
            .shared
            .expected
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(state.to_owned());
    }

    /// The first answer for the expected state, or `Expired`.
    pub async fn outcome(mut self) -> CallbackOutcome {
        (&mut self.outcome)
            .await
            .unwrap_or(CallbackOutcome::Expired)
    }
}

impl Drop for OneShotCallback {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Hands the answer over once; `false` when one was already given.
fn answer(shared: &Shared, outcome: CallbackOutcome) -> bool {
    let sender = shared
        .answer
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    let Some(sender) = sender else {
        return false;
    };
    let _ = sender.send(outcome);
    shared.answered.notify_one();
    true
}

fn page(status: StatusCode, html: Option<&'static str>) -> Response<Body> {
    let mut response = Response::new(html.map_or_else(Body::empty, Body::from));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if html.is_some() {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
    }
    response
}

async fn handle(State(shared): State<Arc<Shared>>, request: Request<Body>) -> Response<Body> {
    if request.method() != Method::GET {
        return page(StatusCode::METHOD_NOT_ALLOWED, None);
    }
    let host = request.headers().get(header::HOST);
    if host.is_none_or(|host| host.as_bytes() != shared.host.as_bytes()) {
        return page(StatusCode::BAD_REQUEST, None);
    }
    if request.uri().path() != CALLBACK_PATH {
        return page(StatusCode::NOT_FOUND, None);
    }
    let mut code = None;
    let mut state = None;
    let mut error = false;
    for (key, value) in url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
    {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = true,
            _ => {}
        }
    }
    let expected = shared
        .expected
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let Some(state) = state.filter(|state| {
        expected
            .as_deref()
            .is_some_and(|expected| bool::from(expected.as_bytes().ct_eq(state.as_bytes())))
    }) else {
        return page(StatusCode::BAD_REQUEST, Some(ERROR_HTML));
    };
    if error {
        // A declined consent ends the attempt (`auth-oauth-handlers.ts:166-177`).
        return if answer(&shared, CallbackOutcome::Denied) {
            page(StatusCode::OK, Some(ERROR_HTML))
        } else {
            page(StatusCode::BAD_REQUEST, Some(ERROR_HTML))
        };
    }
    let Some(code) = code.filter(|code| !code.is_empty()) else {
        return page(StatusCode::BAD_REQUEST, Some(ERROR_HTML));
    };
    if answer(&shared, CallbackOutcome::Code { code, state }) {
        page(StatusCode::OK, Some(SUCCESS_HTML))
    } else {
        page(StatusCode::BAD_REQUEST, Some(ERROR_HTML))
    }
}
