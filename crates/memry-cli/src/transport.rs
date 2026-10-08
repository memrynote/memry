//! The one `Transport` implementation for the headless shell (T112).
//!
//! **It moves bytes and nothing else.** Every retry, every backoff, every token
//! refresh, every "which status means what" decision already lives in
//! `memry_core::protocol::http` (Constitution I). A retry written here would be
//! a second copy of the ladder, and the two would disagree the first time one
//! of them changed — so this file has no `status` comparison in it at all.
//!
//! The one judgement it does make is the seam's own: turning a platform failure
//! into a `TransportError` variant, because the core branches on the variant
//! and the variant is the seam's vocabulary, not a policy. Note what is
//! deliberately *not* produced: `TransportError::Offline` is the reachability
//! seam's word, and a connect failure here is reported as
//! `Failed` — retryable — rather than guessed at.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Once;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use memry_core::api::errors::TransportError;
use memry_core::api::runtime;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, Request};

/// RFC 6455 §7.4.1: 1006 is "closed abnormally", which is what the endpoint
/// reports when no close frame was exchanged.
const ABNORMAL_CLOSURE: u16 = 1006;
/// 1000 is a normal closure, which is what a `close()` from the core is.
const NORMAL_CLOSURE: u16 = 1000;

/// `reqwest` plus `tokio-tungstenite`, sharing one connection pool.
pub struct NativeTransport {
    client: reqwest::Client,
}

impl NativeTransport {
    pub fn new() -> Result<Self, TransportError> {
        install_crypto_provider();
        // No `.timeout()` here: the ceiling is per request and the core sets it
        // (chapter 00 §0.6). A client-wide default would silently override the
        // value the core chose for a long first-sync page.
        let client = reqwest::Client::builder()
            .build()
            .map_err(|err| TransportError::Failed {
                what: format!("could not build the HTTP client: {err}"),
            })?;
        Ok(Self { client })
    }
}

/// `rustls` takes exactly one process-wide crypto provider, and both halves of
/// this seam want one. Installing it twice is an error rather than a no-op, so
/// it happens once and the second answer is discarded.
fn install_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[async_trait::async_trait]
impl Transport for NativeTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let timeout_ms = request.timeout_ms;
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|err| {
            TransportError::Failed {
                what: format!("unusable method `{}`: {err}", request.method),
            }
        })?;

        let mut wire = self
            .client
            .request(method, &request.url)
            .timeout(Duration::from_millis(timeout_ms));
        for (name, value) in &request.headers {
            wire = wire.header(name, value);
        }
        if let Some(body) = request.body {
            wire = wire.body(body);
        }

        let response = wire
            .send()
            .await
            .map_err(|err| classify(&err, timeout_ms))?;
        let status = response.status().as_u16();
        // Lowercase keys, as the seam's contract requires. `reqwest` already
        // lowercases them; the explicit fold is what keeps that true if it ever
        // stops. A header whose value is not UTF-8 is dropped rather than
        // lossily rewritten: no header the protocol reads is binary.
        let headers: HashMap<String, String> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
            })
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|err| classify(&err, timeout_ms))?
            .to_vec();

        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        install_crypto_provider();
        let wire = socket_request(&request)?;
        let (outbound, inbound) = mpsc::unbounded_channel();
        // The core's runtime, not a second one: `runtime::block_on` on a shell
        // thread and this task have to share a timer wheel.
        runtime::spawn(pump(wire, listener, inbound));
        Ok(Arc::new(NativeSocket { outbound }))
    }
}

fn socket_request(request: &SocketRequest) -> Result<Request<()>, TransportError> {
    let mut wire =
        request
            .url
            .as_str()
            .into_client_request()
            .map_err(|err| TransportError::Failed {
                what: format!("unusable socket url `{}`: {err}", request.url),
            })?;
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|err| TransportError::Failed {
                what: format!("unusable header name `{name}`: {err}"),
            })?;
        let value = HeaderValue::from_str(value).map_err(|err| TransportError::Failed {
            what: format!("unusable value for header `{name}`: {err}"),
        })?;
        wire.headers_mut().insert(name, value);
    }
    Ok(wire)
}

/// What the core asked the socket to do. Dropping every sender ends the pump,
/// which is how "dropping the handle closes the socket" is implemented.
enum Outbound {
    Send(Vec<u8>),
    Close,
}

struct NativeSocket {
    outbound: UnboundedSender<Outbound>,
}

impl SocketHandle for NativeSocket {
    fn send(&self, payload: Vec<u8>) -> Result<(), TransportError> {
        self.outbound
            .send(Outbound::Send(payload))
            .map_err(|_| TransportError::SocketClosed {
                code: ABNORMAL_CLOSURE,
                reason: "the socket task has ended".to_string(),
            })
    }

    fn close(&self) {
        let _ = self.outbound.send(Outbound::Close);
    }
}

/// Reads frames up to the listener and writes the core's frames down.
///
/// The listener's methods are called from this task and run synchronously on
/// it, which is the seam's documented contract: a shell never re-enters the
/// core from one.
async fn pump(
    request: Request<()>,
    listener: Arc<dyn SocketListener>,
    mut outbound: UnboundedReceiver<Outbound>,
) {
    let stream = match tokio_tungstenite::connect_async(request).await {
        Ok((stream, _response)) => stream,
        Err(err) => {
            listener.on_error(socket_failure(&err));
            return;
        }
    };
    listener.on_open();
    let (mut writer, mut reader) = stream.split();

    loop {
        tokio::select! {
            command = outbound.recv() => match command {
                Some(Outbound::Send(payload)) => {
                    if let Err(err) = writer.send(Message::Binary(payload.into())).await {
                        listener.on_error(socket_failure(&err));
                        break;
                    }
                }
                // `None` is every handle dropped, which the seam defines as a
                // close.
                Some(Outbound::Close) | None => {
                    let _ = writer.close().await;
                    listener.on_closed(NORMAL_CLOSURE, "closed by the core".to_string());
                    break;
                }
            },
            frame = reader.next() => match frame {
                // Text and binary are the same thing to the core: the socket
                // is a hint channel and the payload is never parsed here
                // (chapter 09).
                Some(Ok(Message::Binary(bytes))) => listener.on_message(bytes.to_vec()),
                Some(Ok(Message::Text(text))) => listener.on_message(text.as_bytes().to_vec()),
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(frame) => (frame.code.into(), frame.reason.to_string()),
                        None => (ABNORMAL_CLOSURE, String::new()),
                    };
                    listener.on_closed(code, reason);
                    break;
                }
                // Ping, pong and continuation: tungstenite answers pings itself.
                Some(Ok(_)) => {}
                Some(Err(err)) => {
                    listener.on_error(socket_failure(&err));
                    break;
                }
                None => {
                    listener.on_closed(ABNORMAL_CLOSURE, "the socket ended".to_string());
                    break;
                }
            },
        }
    }
}

/// One `reqwest` failure in the seam's vocabulary.
fn classify(error: &reqwest::Error, timeout_ms: u64) -> TransportError {
    if error.is_timeout() {
        return TransportError::Timeout {
            elapsed_ms: timeout_ms,
        };
    }
    if let Some(what) = tls_failure(error) {
        return TransportError::Tls { what };
    }
    TransportError::Failed {
        what: error.to_string(),
    }
}

/// A TLS failure anywhere in the source chain.
///
/// Worth the walk: the core refuses to retry a `Tls`, and reporting a
/// certificate rejection as a generic failure would spend the whole ladder
/// re-offering a connection that a possible interception already refused.
fn tls_failure(error: &reqwest::Error) -> Option<String> {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = source {
        if let Some(tls) = error.downcast_ref::<rustls::Error>() {
            return Some(tls.to_string());
        }
        if let Some(io) = error.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
            && let Some(tls) = inner.downcast_ref::<rustls::Error>()
        {
            return Some(tls.to_string());
        }
        source = error.source();
    }
    None
}

/// One `tungstenite` failure in the seam's vocabulary.
fn socket_failure(error: &tokio_tungstenite::tungstenite::Error) -> TransportError {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::ConnectionClosed | Error::AlreadyClosed => TransportError::SocketClosed {
            code: ABNORMAL_CLOSURE,
            reason: error.to_string(),
        },
        Error::Http(response) => TransportError::HandshakeRejected {
            status: response.status().as_u16(),
        },
        Error::Tls(err) => TransportError::Tls {
            what: err.to_string(),
        },
        other => TransportError::Failed {
            what: other.to_string(),
        },
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
