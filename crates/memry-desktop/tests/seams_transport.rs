//! `NativeTransport` against local HTTP and WebSocket servers: it moves bytes, never retries, and
//! reports a failure in the seam's vocabulary.

mod support;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{
    HttpRequest, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_desktop::seams::transport::{
    HOST_NOT_ALLOWED, MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, NativeTransport,
};
use support::{Chain, RecordingSink, Server, serve, setup};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

struct Rig {
    server: Server,
    transport: NativeTransport,
}

async fn rig<H, Fut>(handler: H) -> Rig
where
    H: Fn(tokio_rustls::server::TlsStream<tokio::net::TcpStream>) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let chain = Chain::new("localhost");
    let server = serve(chain.presented(), chain.leaf_key.clone_key(), handler).await;
    let transport = NativeTransport::with_setup(
        setup(&[chain.root.der()], "localhost", &[chain.leaf_pin()], true),
        Arc::new(RecordingSink::default()),
        &["localhost"],
    )
    .unwrap();
    Rig { server, transport }
}

fn request(rig: &Rig, path: &str, timeout_ms: u64) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        url: format!("https://localhost:{}{path}", rig.server.port),
        headers: HashMap::new(),
        body: None,
        timeout_ms,
    }
}

async fn reply(tls: &mut (impl tokio::io::AsyncWrite + Unpin), text: &str) {
    let _ = tls.write_all(text.as_bytes()).await;
    let _ = tls.shutdown().await;
}

#[tokio::test]
async fn a_request_that_outlives_its_own_timeout_is_a_timeout() {
    let rig = rig(|mut tls| async move {
        let _ = support::read_head(&mut tls).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
    })
    .await;
    let error = rig
        .transport
        .send(request(&rig, "/", 300))
        .await
        .unwrap_err();
    assert_eq!(error, TransportError::Timeout { elapsed_ms: 300 });
}

#[tokio::test]
async fn a_429_with_retry_after_is_a_response_with_lowercase_header_keys() {
    let rig = rig(|mut tls| async move {
        let _ = support::read_head(&mut tls).await;
        reply(
            &mut tls,
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nX-Mixed-CASE: v\r\ncontent-length: 4\r\nconnection: close\r\n\r\nslow",
        )
        .await;
    })
    .await;
    let response = rig.transport.send(request(&rig, "/", 5_000)).await.unwrap();
    assert_eq!(response.status, 429);
    assert_eq!(response.body, b"slow");
    assert_eq!(
        response.headers.get("retry-after").map(String::as_str),
        Some("7")
    );
    assert_eq!(
        response.headers.get("x-mixed-case").map(String::as_str),
        Some("v")
    );
    assert!(
        response
            .headers
            .keys()
            .all(|k| *k == k.to_ascii_lowercase())
    );
}

#[tokio::test]
async fn request_headers_reach_the_server_as_the_core_built_them() {
    let rig = rig(|mut tls| async move {
        let head = support::read_head(&mut tls).await;
        reply(
            &mut tls,
            &format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{head}",
                head.len()
            ),
        )
        .await;
    })
    .await;
    let mut wire = request(&rig, "/sync/status", 5_000);
    wire.headers
        .insert("x-memry-client".into(), "desktop/1.2.3+45".into());
    wire.headers
        .insert("x-memry-sync-types".into(), "note,task,journal".into());
    wire.headers
        .insert("authorization".into(), "Bearer abc.def".into());
    let echoed = String::from_utf8(rig.transport.send(wire).await.unwrap().body).unwrap();
    for line in [
        "x-memry-client: desktop/1.2.3+45",
        "x-memry-sync-types: note,task,journal",
        "authorization: Bearer abc.def",
    ] {
        assert!(echoed.contains(line), "{line} missing from {echoed}");
    }
}

#[tokio::test]
async fn a_redirect_inside_the_allowed_hosts_is_followed_and_one_off_them_is_not() {
    let rig = rig(|mut tls| async move {
        let head = support::read_head(&mut tls).await;
        let text = if head.starts_with("GET /next") {
            "HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnext".to_owned()
        } else if head.starts_with("GET /away") {
            "HTTP/1.1 302 Found\r\nLocation: https://example.com/x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
        } else {
            "HTTP/1.1 302 Found\r\nLocation: /next\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
        };
        reply(&mut tls, &text).await;
    })
    .await;
    let followed = rig.transport.send(request(&rig, "/", 5_000)).await.unwrap();
    assert_eq!((followed.status, followed.body), (200, b"next".to_vec()));

    let away = rig
        .transport
        .send(request(&rig, "/away", 5_000))
        .await
        .unwrap();
    assert_eq!(away.status, 302);
    assert_eq!(
        away.headers.get("location").map(String::as_str),
        Some("https://example.com/x")
    );
}

#[tokio::test]
async fn send_no_redirect_returns_the_3xx_with_its_location() {
    let rig = rig(|mut tls| async move {
        let _ = support::read_head(&mut tls).await;
        reply(
            &mut tls,
            "HTTP/1.1 302 Found\r\nLocation: /next\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
    })
    .await;
    let response = rig
        .transport
        .send_no_redirect(request(&rig, "/oauth", 5_000))
        .await
        .unwrap();
    assert_eq!(response.status, 302);
    assert_eq!(
        response.headers.get("location").map(String::as_str),
        Some("/next")
    );
}

#[tokio::test]
async fn only_memry_hosts_over_a_secure_scheme_are_served() {
    let sink = Arc::new(RecordingSink::default());
    let transport = NativeTransport::new(sink).unwrap();
    let get = |url: &str| HttpRequest {
        method: "GET".into(),
        url: url.to_owned(),
        headers: HashMap::new(),
        body: None,
        timeout_ms: 1_000,
    };
    for url in [
        "https://example.com/",
        "https://memrynote.com.evil.example/",
        "https://evilmemrynote.com/",
        "http://sync.memrynote.com/",
        "https://127.0.0.1/",
    ] {
        let error = transport.send(get(url)).await.unwrap_err();
        assert!(
            matches!(&error, TransportError::Failed { what } if what.starts_with(HOST_NOT_ALLOWED)),
            "{url}: {error:?}"
        );
        let error = transport.send_no_redirect(get(url)).await.unwrap_err();
        assert!(matches!(error, TransportError::Failed { .. }), "{url}");
    }
    let socket = transport.open_socket(
        SocketRequest {
            url: "wss://example.com/ws".into(),
            headers: HashMap::new(),
        },
        Arc::new(Collector::new().0),
    );
    assert!(
        matches!(socket, Err(TransportError::Failed { what }) if what.starts_with(HOST_NOT_ALLOWED))
    );
}

#[tokio::test]
async fn a_body_over_the_cap_is_refused_by_its_length_or_as_it_streams() {
    let rig = rig(|mut tls| async move {
        let head = support::read_head(&mut tls).await;
        if head.starts_with("GET /declared") {
            reply(
                &mut tls,
                &format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    MAX_RESPONSE_BYTES + 1
                ),
            )
            .await;
        } else {
            let _ = tls
                .write_all(
                    b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                )
                .await;
            let megabyte = vec![b'a'; 1 << 20];
            for _ in 0..=(MAX_RESPONSE_BYTES >> 20) {
                if tls.write_all(b"100000\r\n").await.is_err()
                    || tls.write_all(&megabyte).await.is_err()
                    || tls.write_all(b"\r\n").await.is_err()
                {
                    return;
                }
            }
            let _ = tls.write_all(b"0\r\n\r\n").await;
            let _ = tls.shutdown().await;
        }
    })
    .await;
    for path in ["/declared", "/streamed"] {
        let error = rig
            .transport
            .send(request(&rig, path, 60_000))
            .await
            .unwrap_err();
        assert!(
            matches!(&error, TransportError::Failed { what } if what.contains("larger than")),
            "{path}: {error:?}"
        );
    }
}

#[derive(Debug, PartialEq)]
enum Event {
    Open,
    Message(Vec<u8>),
    Closed(u16),
    Error(TransportError),
}

struct Collector(mpsc::UnboundedSender<Event>);

impl Collector {
    fn new() -> (Self, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self(tx), rx)
    }
}

impl SocketListener for Collector {
    fn on_open(&self) {
        let _ = self.0.send(Event::Open);
    }
    fn on_message(&self, payload: Vec<u8>) {
        let _ = self.0.send(Event::Message(payload));
    }
    fn on_closed(&self, code: u16, _reason: String) {
        let _ = self.0.send(Event::Closed(code));
    }
    fn on_error(&self, error: TransportError) {
        let _ = self.0.send(Event::Error(error));
    }
}

async fn next(events: &mut mpsc::UnboundedReceiver<Event>) -> Event {
    tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("a socket event")
        .expect("the socket stayed open")
}

fn open(
    rig: &Rig,
) -> Result<(Arc<dyn SocketHandle>, mpsc::UnboundedReceiver<Event>), TransportError> {
    let (collector, events) = Collector::new();
    let handle = rig.transport.open_socket(
        SocketRequest {
            url: format!("wss://localhost:{}/ws", rig.server.port),
            headers: HashMap::from([("x-memry-client".to_owned(), "desktop/1".to_owned())]),
        },
        Arc::new(collector),
    )?;
    Ok((handle, events))
}

#[tokio::test]
async fn a_websocket_echoes_and_closes() {
    let rig = rig(|tls| async move {
        let Ok(mut socket) = tokio_tungstenite::accept_async(tls).await else {
            return;
        };
        while let Some(Ok(message)) = socket.next().await {
            if message.is_binary() || message.is_text() {
                let _ = socket.send(message).await;
            }
        }
    })
    .await;
    let (handle, mut events) = open(&rig).unwrap();
    assert_eq!(next(&mut events).await, Event::Open);
    handle.send(b"hint".to_vec()).unwrap();
    assert_eq!(next(&mut events).await, Event::Message(b"hint".to_vec()));
    handle.close();
    assert_eq!(next(&mut events).await, Event::Closed(1000));
}

#[tokio::test]
async fn a_refused_handshake_is_handshake_rejected_with_its_status() {
    let rig = rig(|mut tls| async move {
        let _ = support::read_head(&mut tls).await;
        reply(
            &mut tls,
            "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
    })
    .await;
    let (_handle, mut events) = open(&rig).unwrap();
    assert_eq!(
        next(&mut events).await,
        Event::Error(TransportError::HandshakeRejected { status: 403 })
    );
}

#[tokio::test]
async fn a_frame_over_the_cap_ends_the_socket_with_an_error() {
    let rig = rig(|tls| async move {
        let Ok(mut socket) = tokio_tungstenite::accept_async(tls).await else {
            return;
        };
        let _ = socket
            .send(Message::Binary(vec![1_u8; MAX_FRAME_BYTES + 1].into()))
            .await;
        let _ = socket.next().await;
    })
    .await;
    let (_handle, mut events) = open(&rig).unwrap();
    assert_eq!(next(&mut events).await, Event::Open);
    assert!(matches!(
        next(&mut events).await,
        Event::Error(TransportError::Failed { .. })
    ));
}

#[tokio::test]
async fn after_a_pin_mismatch_the_socket_is_refused_without_connecting() {
    let chain = Chain::new("localhost");
    let other = Chain::new("localhost");
    let server = serve(
        chain.presented(),
        chain.leaf_key.clone_key(),
        |mut tls| async move {
            let _ = support::read_head(&mut tls).await;
        },
    )
    .await;
    let sink = Arc::new(RecordingSink::default());
    let transport = NativeTransport::with_setup(
        setup(&[chain.root.der()], "localhost", &[other.leaf_pin()], true),
        sink.clone(),
        &["localhost"],
    )
    .unwrap();
    let socket = |transport: &NativeTransport| {
        let (collector, events) = Collector::new();
        let result = transport.open_socket(
            SocketRequest {
                url: format!("wss://localhost:{}/ws", server.port),
                headers: HashMap::new(),
            },
            Arc::new(collector),
        );
        (result.map(|_| ()), events)
    };

    // The socket's own handshake hits the mismatch: the listener hears a TLS error.
    let (opened, mut events) = socket(&transport);
    opened.unwrap();
    assert!(matches!(
        next(&mut events).await,
        Event::Error(TransportError::Tls { .. })
    ));
    assert_eq!(sink.failures().len(), 1);
    assert!(transport.socket_blocked_by_pin());

    // From now on the socket is not even attempted.
    let connections = server.accepted();
    let (refused, _events) = socket(&transport);
    assert!(matches!(refused, Err(TransportError::Tls { .. })));
    assert_eq!(server.accepted(), connections);
    assert_eq!(sink.failures().len(), 1);
}

#[tokio::test]
async fn a_pin_mismatch_on_a_plain_request_also_blocks_the_socket() {
    let chain = Chain::new("localhost");
    let other = Chain::new("localhost");
    let server = serve(
        chain.presented(),
        chain.leaf_key.clone_key(),
        |mut tls| async move {
            let _ = support::read_head(&mut tls).await;
        },
    )
    .await;
    let sink = Arc::new(RecordingSink::default());
    let transport = NativeTransport::with_setup(
        setup(&[chain.root.der()], "localhost", &[other.leaf_pin()], true),
        sink.clone(),
        &["localhost"],
    )
    .unwrap();
    let error = transport
        .send(HttpRequest {
            method: "GET".into(),
            url: format!("https://localhost:{}/", server.port),
            headers: HashMap::new(),
            body: None,
            timeout_ms: 5_000,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, TransportError::Tls { .. }));
    let connections = server.accepted();
    let refused = transport.open_socket(
        SocketRequest {
            url: format!("wss://localhost:{}/ws", server.port),
            headers: HashMap::new(),
        },
        Arc::new(Collector::new().0),
    );
    assert!(matches!(refused, Err(TransportError::Tls { .. })));
    assert_eq!(server.accepted(), connections);
}
