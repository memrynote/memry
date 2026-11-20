//! How the capture server reads a request (Step 27, #3544): JSON text with an unpaired UTF-16
//! surrogate escape, which the shipped extension sends, and the limits that keep a slow or
//! idle client from holding the server: header and request timeouts, the connection cap, and
//! the connections closing when the server stops. Timeouts are short here; the assertions are
//! on what the client receives, never on how long it took.

use std::time::Duration;

use memry_desktop::services::capture::{Limits, schema};
use memry_test_kit::proptest_config;
use proptest::prelude::*;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::capture_support::{CHROME, article, env, req, runtime, send_raw};

/// A hang guard for a read that must end: the test fails instead of hanging.
const HANG: Duration = Duration::from_secs(30);
const SHORT: Duration = Duration::from_millis(200);

/// Everything the server sends until it closes the connection (a reset counts as closed).
async fn read_until_closed(stream: &mut TcpStream) -> String {
    let read = async {
        let mut answer = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return answer,
                Ok(n) => answer.extend_from_slice(&chunk[..n]),
            }
        }
    };
    let answer = tokio::time::timeout(HANG, read)
        .await
        .expect("the server closed the connection");
    String::from_utf8_lossy(&answer).into_owned()
}

/// `body` with the article's excerpt replaced by `excerpt`, written as raw JSON text.
fn with_excerpt(url: &str, excerpt: &str) -> String {
    let body = article(url).to_string();
    let replaced = body.replace(
        r#""excerpt":"Body text.""#,
        &format!(r#""excerpt":"{excerpt}""#),
    );
    assert_ne!(body, replaced);
    replaced
}

#[test]
fn a_capture_with_an_unpaired_surrogate_escape_is_stored_with_a_replacement_character() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let token = e.paired(CHROME);
        let cases = [
            // `selectionText.slice(0, 200)` cut an emoji after its high half.
            (r"abc\ud83d", "abc\u{fffd}"),
            (r"\ud83d\ude00 ok", "\u{1f600} ok"),
            (r"\ude00x\ud83d\ud83d\ude00", "\u{fffd}x\u{fffd}\u{1f600}"),
            // An escaped backslash before `u` is text, not an escape.
            (r"\\ud83d", r"\ud83d"),
        ];
        for (i, (sent, stored)) in cases.into_iter().enumerate() {
            let url = format!("https://example.com/cut/{i}");
            let resp = req("POST", "/capture")
                .authed(CHROME, &token)
                .body(with_excerpt(&url, sent))
                .send(server.port())
                .await;
            assert_eq!(resp.status, 200, "{sent}: {:?}", resp.body);
            let id = resp.body["itemId"].as_str().unwrap();
            let open = e.session.current().unwrap();
            let item = open
                .vault
                .inbox(e.store.clone())
                .unwrap()
                .get(id.to_owned());
            let metadata = item.unwrap().unwrap().metadata_json.unwrap();
            let metadata: Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(metadata["excerpt"], stored, "{sent}");
        }
    });
}

#[test]
fn well_formed_json_text_is_left_as_it_is() {
    for text in [
        r#"{"a":"\ud83d\ude00"}"#,
        r#"{"a":"\\ud83d"}"#,
        r#"["\u00e9", 1]"#,
    ] {
        assert!(matches!(
            schema::to_well_formed(text),
            std::borrow::Cow::Borrowed(_)
        ));
    }
    // Outside a string a backslash is invalid JSON either way; it is left for the parser.
    assert_eq!(schema::to_well_formed(r"[\ud83d]"), r"[\ud83d]");
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// `JSON.parse` keeps any code units; once they reach UTF-8 every unpaired one is U+FFFD.
    #[test]
    fn escaped_code_units_parse_as_javascript_then_utf8_gives_them(
        units in prop::collection::vec(any::<u16>(), 0..40),
    ) {
        let escaped: String = units.iter().map(|unit| format!("\\u{unit:04x}")).collect();
        let text = format!("\"{escaped}\"");
        let parsed: String = serde_json::from_str(&schema::to_well_formed(&text)).unwrap();
        prop_assert_eq!(parsed, String::from_utf16_lossy(&units));
    }

    #[test]
    fn json_a_rust_string_serializes_to_needs_no_change(text in "\\PC{0,60}") {
        let json = serde_json::to_string(&text).unwrap();
        prop_assert_eq!(schema::to_well_formed(&json), json.as_str());
    }
}

#[test]
fn a_client_that_never_finishes_its_headers_is_disconnected() {
    let e = env();
    runtime().block_on(async {
        let limits = Limits {
            header_read: SHORT,
            ..Limits::default()
        };
        let server = e.start_with(limits).await;
        let port = server.port();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let head = format!("GET /ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
        stream.write_all(head.as_bytes()).await.unwrap();
        let answer = read_until_closed(&mut stream).await;
        assert!(!answer.contains(" 200 "), "{answer}");
    });
}

#[test]
fn a_body_that_stops_arriving_ends_with_408_or_its_refusal() {
    let e = env();
    runtime().block_on(async {
        let limits = Limits {
            request: SHORT,
            ..Limits::default()
        };
        let server = e.start_with(limits).await;
        let port = server.port();
        let token = e.paired(CHROME);
        for (bearer, expected) in [(token.as_str(), "408"), ("wrong", "401")] {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let head = format!(
                "POST /capture HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {CHROME}\r\n\
                 X-Memry-Capture: 1\r\nAuthorization: Bearer {bearer}\r\n\
                 Content-Length: 1000\r\n\r\n{{\"url\":"
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            let answer = read_until_closed(&mut stream).await;
            let status = answer.split(' ').nth(1).unwrap_or("");
            assert_eq!(status, expected, "{answer}");
        }
    });
}

/// A connection that sent half a request head and holds its slot.
async fn half_open(port: u16) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(b"GET /ping HTTP/1.1\r\n").await.unwrap();
    stream
}

#[test]
fn a_connection_over_the_cap_waits_for_a_free_slot() {
    let e = env();
    runtime().block_on(async {
        let limits = Limits {
            connections: 1,
            ..Limits::default()
        };
        let server = e.start_with(limits).await;
        let port = server.port();
        let held = half_open(port).await;
        let waiting = tokio::spawn(req("GET", "/ping").send(port));
        tokio::time::sleep(SHORT).await;
        assert!(!waiting.is_finished(), "served past the connection cap");
        drop(held);
        let resp = tokio::time::timeout(HANG, waiting).await.unwrap().unwrap();
        assert_eq!(resp.status, 200);
    });
}

#[test]
fn stopping_the_server_closes_the_connections_it_serves() {
    let e = env();
    runtime().block_on(async {
        let limits = Limits {
            connections: 1,
            ..Limits::default()
        };
        let server = e.start_with(limits).await;
        let port = server.port();
        let mut held = half_open(port).await;
        // The held connection has the only slot once a second one waits.
        let waiting = tokio::spawn(async move {
            let ping = format!("GET /ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
            send_raw(port, ping.as_bytes()).await
        });
        tokio::time::sleep(SHORT).await;
        assert!(!waiting.is_finished(), "served past the connection cap");
        waiting.abort();
        drop(server);
        assert_eq!(read_until_closed(&mut held).await, "");
    });
}
