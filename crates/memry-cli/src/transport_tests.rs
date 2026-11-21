use super::*;
use memry_core::protocol::http::IDLE_TIMEOUT_MS;
use memry_core::sync::pack_bootstrap::{RECORD_DOWNLOAD_WIDTH, pack_deadline_ms};
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

/// An 8 MiB pack, the size #5331 names.
const PACK_BYTES: usize = 8 * 1024 * 1024;
/// `PACK_TARGET_BYTES`, the size the server fills packs toward
/// (`apps/sync-server/src/services/pack-sizing.ts:15`).
const TARGET_PACK_BYTES: usize = 24 * 1024 * 1024;
/// 0.5 Mbit/s is 62,500 bytes a second: 31,250 bytes every 500 ms, shared by
/// every stream in flight.
const SLOW_WRITE: usize = 31_250;
const SLOW_EVERY: Duration = Duration::from_millis(500);

/// Serves `streams` GETs of `bytes` each, splitting 0.5 Mbit/s evenly between
/// them. With `stall_after`, each goes silent once that many body bytes are
/// out, and keeps its socket open.
async fn slow_packs(streams: usize, bytes: usize, stall_after: Option<usize>) -> String {
    // A paused clock jumps to the next timer whenever no task is ready, and a
    // task waiting on a real socket is not ready: without this ticker the
    // clock would leap to the idle limit while the loopback bytes are in
    // flight. One millisecond at a time, it can only drift by a few.
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://{}/pack", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        for _ in 0..streams {
            let (socket, _) = listener.accept().await.expect("accept");
            tokio::spawn(serve_slowly(
                socket,
                bytes,
                SLOW_WRITE / streams,
                stall_after,
            ));
        }
    });
    url
}

async fn serve_slowly(
    mut socket: tokio::net::TcpStream,
    bytes: usize,
    write: usize,
    stall_after: Option<usize>,
) {
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = socket.read(&mut chunk).await.expect("read");
        assert!(read > 0, "the client hung up before its request ended");
        head.extend_from_slice(&chunk[..read]);
    }
    let status = format!("HTTP/1.1 200 OK\r\nContent-Length: {bytes}\r\n\r\n");
    socket.write_all(status.as_bytes()).await.expect("head");
    let block = vec![7u8; write];
    let mut sent = 0;
    while sent < bytes && stall_after.is_none_or(|at| sent < at) {
        tokio::time::sleep(SLOW_EVERY).await;
        let n = write.min(bytes - sent);
        socket.write_all(&block[..n]).await.expect("body");
        sent += n;
    }
    std::future::pending::<()>().await;
    drop(socket);
}

fn pack_get(url: &str, bytes: usize) -> HttpRequest {
    HttpRequest {
        method: "GET".to_string(),
        url: url.to_string(),
        headers: HashMap::new(),
        body: None,
        timeout_ms: pack_deadline_ms(Some(bytes as u64)),
    }
}

/// #5331: slow but steady finishes. The clock is paused, so the ~134 s of
/// transfer run in virtual time.
#[tokio::test(start_paused = true)]
async fn an_eight_mib_pack_at_half_a_megabit_arrives_whole() {
    let url = slow_packs(1, PACK_BYTES, None).await;
    let started = tokio::time::Instant::now();
    let response = NativeTransport::new()
        .expect("a transport")
        .send(pack_get(&url, PACK_BYTES))
        .await
        .expect("the slow pack arrives");
    assert_eq!(response.status, 200);
    assert_eq!(response.body.len(), PACK_BYTES);
    let transfer = SLOW_EVERY * PACK_BYTES.div_ceil(SLOW_WRITE) as u32;
    assert!(started.elapsed() >= transfer, "{:?}", started.elapsed());
}

/// #5331: the core downloads `RECORD_DOWNLOAD_WIDTH` packs at once, so three
/// target-size packs share 0.5 Mbit/s and each takes about 1,208 s. Every one
/// still arrives inside its deadline.
#[tokio::test(start_paused = true)]
async fn three_target_size_packs_sharing_half_a_megabit_all_arrive() {
    assert_eq!(RECORD_DOWNLOAD_WIDTH, 3);
    let url = slow_packs(RECORD_DOWNLOAD_WIDTH, TARGET_PACK_BYTES, None).await;
    let transport = NativeTransport::new().expect("a transport");
    let started = tokio::time::Instant::now();
    let (a, b, c) = tokio::join!(
        transport.send(pack_get(&url, TARGET_PACK_BYTES)),
        transport.send(pack_get(&url, TARGET_PACK_BYTES)),
        transport.send(pack_get(&url, TARGET_PACK_BYTES)),
    );
    for response in [a, b, c] {
        let response = response.expect("each shared pack arrives");
        assert_eq!(response.body.len(), TARGET_PACK_BYTES);
    }
    let share = SLOW_WRITE / RECORD_DOWNLOAD_WIDTH;
    let transfer = SLOW_EVERY * TARGET_PACK_BYTES.div_ceil(share) as u32;
    assert!(started.elapsed() >= transfer, "{:?}", started.elapsed());
}

/// #5331: a stall mid-body fails one idle limit after the last byte, not at
/// the pack's much later deadline.
#[tokio::test(start_paused = true)]
async fn a_pack_that_stalls_mid_body_fails_at_the_idle_limit() {
    let half = PACK_BYTES / 2;
    let url = slow_packs(1, PACK_BYTES, Some(half)).await;
    let started = tokio::time::Instant::now();
    let error = NativeTransport::new()
        .expect("a transport")
        .send(pack_get(&url, PACK_BYTES))
        .await
        .expect_err("the stall is cut off");
    let elapsed = started.elapsed();
    assert_eq!(
        error,
        TransportError::Timeout {
            elapsed_ms: IDLE_TIMEOUT_MS
        }
    );
    let last_byte = SLOW_EVERY * half.div_ceil(SLOW_WRITE) as u32;
    let idle = Duration::from_millis(IDLE_TIMEOUT_MS);
    assert!(
        elapsed >= last_byte + idle && elapsed < last_byte + idle + SLOW_EVERY,
        "failed after {elapsed:?}; the last byte left at {last_byte:?}"
    );
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
