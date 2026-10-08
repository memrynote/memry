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

#[tokio::test]
async fn a_refused_handshake_reports_its_status() {
    let (url, _served) = fake_http(
        b"HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    )
    .await;
    let recorder = Arc::new(Recorder::default());
    let _handle = NativeTransport::new()
        .expect("a transport")
        .open_socket(
            SocketRequest {
                url: url.replacen("http://", "ws://", 1),
                headers: HashMap::new(),
            },
            recorder.clone(),
        )
        .expect("opening is synchronous");

    until("error", || {
        recorder
            .events()
            .iter()
            .any(|event| event.starts_with("error:"))
    })
    .await;
    assert_eq!(
        recorder.events(),
        [TransportError::HandshakeRejected { status: 426 }.to_string()]
            .map(|error| format!("error:{error}"))
    );
}
