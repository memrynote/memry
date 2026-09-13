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
        Error::Tls(err) => TransportError::Tls {
            what: err.to_string(),
        },
        other => TransportError::Failed {
            what: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// What the fake server saw, so a test can assert the bytes that left.
    #[derive(Debug, Default)]
    struct Seen {
        head: String,
        body: Vec<u8>,
    }

    /// Serves exactly one request and answers with `response`.
    async fn fake_http(response: &'static [u8]) -> (String, tokio::task::JoinHandle<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/probe", listener.local_addr().expect("addr"));
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let read = socket.read(&mut chunk).await.expect("read");
                raw.extend_from_slice(&chunk[..read]);
                let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n");
                if read == 0 {
                    break;
                }
                if let Some(end) = head_end {
                    let head = String::from_utf8_lossy(&raw[..end]).to_string();
                    let want = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    let mut body = raw[end + 4..].to_vec();
                    while body.len() < want {
                        let read = socket.read(&mut chunk).await.expect("read body");
                        body.extend_from_slice(&chunk[..read]);
                    }
                    socket.write_all(response).await.expect("write");
                    socket.flush().await.expect("flush");
                    return Seen { head, body };
                }
            }
            Seen::default()
        });
        (url, served)
    }

    #[tokio::test]
    async fn a_request_crosses_the_seam_byte_for_byte() {
        let (url, served) = fake_http(
            b"HTTP/1.1 418 I'm a teapot\r\nX-Memry-Echo: one\r\nContent-Length: 5\r\n\r\nbrew!",
        )
        .await;

        let request = HttpRequest {
            method: "POST".to_string(),
            url,
            headers: HashMap::from([("x-memry-client".to_string(), "desktop/1.2.3".to_string())]),
            body: Some(b"{\"hello\":true}".to_vec()),
            timeout_ms: 5_000,
        };
        let response = NativeTransport::new()
            .expect("a transport")
            .send(request)
            .await
            .expect("a response");

        let seen = served.await.expect("the fake server finished");
        assert!(
            seen.head.starts_with("POST /probe HTTP/1.1"),
            "{}",
            seen.head
        );
        assert!(
            seen.head
                .to_ascii_lowercase()
                .contains("x-memry-client: desktop/1.2.3"),
            "{}",
            seen.head
        );
        assert_eq!(seen.body, b"{\"hello\":true}");

        // A non-2xx is a response, not an error: the seam hands it back whole.
        assert_eq!(response.status, 418);
        assert_eq!(response.body, b"brew!");
        assert_eq!(
            response.headers.get("x-memry-echo").map(String::as_str),
            Some("one")
        );
    }

    #[tokio::test]
    async fn the_per_request_ceiling_is_reported_as_a_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/slow", listener.local_addr().expect("addr"));
        let _quiet = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            // Never answers, and never drops: the ceiling is what ends this.
            std::future::pending::<()>().await;
            drop(socket);
        });

        let error = NativeTransport::new()
            .expect("a transport")
            .send(HttpRequest {
                method: "GET".to_string(),
                url,
                headers: HashMap::new(),
                body: None,
                timeout_ms: 150,
            })
            .await
            .expect_err("the ceiling elapses");
        assert_eq!(error, TransportError::Timeout { elapsed_ms: 150 });
    }

    #[tokio::test]
    async fn an_unusable_method_never_reaches_the_network() {
        let error = NativeTransport::new()
            .expect("a transport")
            .send(HttpRequest {
                method: "not a method".to_string(),
                url: "http://127.0.0.1:1/nowhere".to_string(),
                headers: HashMap::new(),
                body: None,
                timeout_ms: 100,
            })
            .await
            .expect_err("the method is refused");
        assert!(matches!(error, TransportError::Failed { .. }));
    }

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<String>>,
        messages: Mutex<Vec<Vec<u8>>>,
    }

    impl Recorder {
        fn events(&self) -> Vec<String> {
            self.events.lock().expect("the recorder").clone()
        }
    }

    impl SocketListener for Recorder {
        fn on_open(&self) {
            self.events
                .lock()
                .expect("the recorder")
                .push("open".into());
        }
        fn on_message(&self, payload: Vec<u8>) {
            self.events
                .lock()
                .expect("the recorder")
                .push("message".into());
            self.messages.lock().expect("the recorder").push(payload);
        }
        fn on_closed(&self, code: u16, _reason: String) {
            self.events
                .lock()
                .expect("the recorder")
                .push(format!("closed:{code}"));
        }
        fn on_error(&self, error: TransportError) {
            self.events
                .lock()
                .expect("the recorder")
                .push(format!("error:{error}"));
        }
    }

    async fn until<F: Fn() -> bool>(what: &str, done: F) {
        for _ in 0..200 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the socket never reached `{what}`");
    }

    #[tokio::test]
    async fn the_socket_carries_frames_in_both_directions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("ws://{}/realtime", listener.local_addr().expect("addr"));
        let served = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let mut stream = tokio_tungstenite::accept_async(socket)
                .await
                .expect("handshake");
            stream
                .send(Message::Binary(b"hint".to_vec().into()))
                .await
                .expect("send the hint");
            let echoed = stream.next().await.expect("a frame").expect("a message");
            // Stays open until the client closes, so the close this test
            // asserts is the client's own and not a reset from this side.
            while let Some(Ok(frame)) = stream.next().await {
                if frame.is_close() {
                    break;
                }
            }
            echoed.into_data().to_vec()
        });

        let recorder = Arc::new(Recorder::default());
        let handle = NativeTransport::new()
            .expect("a transport")
            .open_socket(
                SocketRequest {
                    url,
                    headers: HashMap::from([(
                        "x-memry-client".to_string(),
                        "desktop/1.2.3".to_string(),
                    )]),
                },
                recorder.clone(),
            )
            .expect("the socket opens");

        until("message", || {
            recorder.events().contains(&"message".to_string())
        })
        .await;
        assert_eq!(
            recorder.messages.lock().expect("the recorder").as_slice(),
            [b"hint".to_vec()]
        );
        handle.send(b"pulled".to_vec()).expect("the write queues");

        // Dropping the handle closes the socket, without a `close()` call.
        drop(handle);
        assert_eq!(served.await.expect("the fake server finished"), b"pulled");
        until("closed", || {
            recorder
                .events()
                .iter()
                .any(|event| event.starts_with("closed:"))
        })
        .await;
        assert_eq!(recorder.events().first().map(String::as_str), Some("open"));
    }

    #[tokio::test]
    async fn a_socket_that_cannot_connect_reports_through_the_listener() {
        let recorder = Arc::new(Recorder::default());
        let _handle = NativeTransport::new()
            .expect("a transport")
            .open_socket(
                SocketRequest {
                    // Port 1 on loopback: nothing listens, and the seam reports
                    // readiness and failure through the listener, never through
                    // the return value.
                    url: "ws://127.0.0.1:1/realtime".to_string(),
                    headers: HashMap::new(),
                },
                recorder.clone(),
            )
            .expect("opening is synchronous and does not await the connect");

        until("error", || {
            recorder
                .events()
                .iter()
                .any(|event| event.starts_with("error:"))
        })
        .await;
    }
}
