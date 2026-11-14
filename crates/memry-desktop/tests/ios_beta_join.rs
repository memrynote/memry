//! `ios_beta::join` against a real local HTTP server: the body the sync server's
//! `IosBetaJoinRequestSchema` reads, the install id only while telemetry is on, a server
//! refusal as `success: false` with the server's message, and the email check of the schema.

use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::ios_beta::{IosBetaJoinInput, IosBetaSource, join};
use memry_desktop::telemetry::service::{Context, Sender, Service};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const INSTALL_ID: &str = "11111111-1111-4111-8111-111111111111";

/// Answers one request with `status` and `body` and hands back its path and body.
async fn server(
    status: &'static str,
    response: &'static str,
) -> (String, tokio::sync::oneshot::Receiver<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!(
        "http://{}/ios-beta/join",
        listener.local_addr().expect("addr")
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let (head, body) = loop {
            let n = socket.read(&mut chunk).await.unwrap_or(0);
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let want = head
                    .to_lowercase()
                    .split("content-length: ")
                    .nth(1)
                    .and_then(|r| r.split("\r\n").next()?.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if body.len() >= want || n == 0 {
                    break (head.to_owned(), body.to_owned());
                }
            } else if n == 0 {
                break (text, String::new());
            }
        };
        let path = head
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_owned();
        let _ = tx.send((path, body));
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                )
                .as_bytes(),
            )
            .await;
    });
    (url, rx)
}

fn telemetry(dir: &std::path::Path, enabled: bool) -> Service {
    let context = Context {
        install_id: INSTALL_ID.into(),
        session_id: "s".into(),
        app_version: "1.2.3".into(),
        build_channel: "production".into(),
        platform: "darwin".into(),
        arch: "arm64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    // An endpoint nothing listens on: these tests never flush.
    let sender = Sender::new(
        "http://127.0.0.1:9/telemetry/batch",
        NativeTransport::loopback(),
    );
    Service::start(dir, context, sender, enabled)
}

fn input(email: &str) -> IosBetaJoinInput {
    IosBetaJoinInput {
        email: email.into(),
        source: IosBetaSource::HelpMenu,
    }
}

async fn joined(
    enabled: bool,
    status: &'static str,
    response: &'static str,
) -> (Value, memry_desktop::telemetry::ios_beta::IosBetaJoinResult) {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().expect("dir");
    let (url, rx) = server(status, response).await;
    let result = join(
        NativeTransport::loopback().as_ref(),
        &url,
        input(" me@example.com "),
        Some(&telemetry(dir.path(), enabled)),
    )
    .await;
    let (path, body) = rx.await.expect("request");
    assert_eq!(path, "/ios-beta/join");
    (serde_json::from_str(&body).expect("json body"), result)
}

#[tokio::test]
async fn telemetry_on_sends_the_install_id() {
    let (body, result) = joined(true, "200 OK", "{\"success\":true}").await;
    assert_eq!(
        body,
        json!({
            "email": "me@example.com",
            "source": "help_menu",
            "installId": INSTALL_ID,
            "appVersion": "1.2.3",
            "platform": "darwin"
        })
    );
    assert!(result.success && result.error.is_none(), "{result:?}");
}

#[tokio::test]
async fn telemetry_off_sends_no_install_id() {
    let (body, result) = joined(false, "200 OK", "{\"success\":true}").await;
    assert_eq!(
        body,
        json!({
            "email": "me@example.com",
            "source": "help_menu",
            "appVersion": "1.2.3",
            "platform": "darwin"
        })
    );
    assert!(result.success, "{result:?}");
}

/// The server's refusal reaches the renderer as Electron's `postToServer` reports it
/// (`apps/desktop/src/main/sync/http-client.ts`): the `error.message` of the JSON body.
#[tokio::test]
async fn a_refused_join_carries_the_server_message() {
    let (_, result) = joined(
        true,
        "502 Bad Gateway",
        r#"{"error":{"code":"INTERNAL_ERROR","message":"Could not send the TestFlight invite. Please try again."}}"#,
    )
    .await;
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Could not send the TestFlight invite. Please try again.")
    );
}

/// The fallbacks of `syncFetch`: a string `error`, a top-level `message`, a JSON body with
/// neither, a body that is not JSON, and `RateLimitError` for 429 whatever the body says.
#[tokio::test]
async fn a_refusal_without_a_server_message_falls_back_as_electron_does() {
    let cases: [(&'static str, &'static str, &str); 5] = [
        ("400 Bad Request", r#"{"error":"Bad input"}"#, "Bad input"),
        ("503 Service Unavailable", r#"{"message":"Down"}"#, "Down"),
        ("500 Internal Server Error", "{}", "Server error (500)"),
        ("502 Bad Gateway", "<html>", "Server returned 502"),
        (
            "429 Too Many Requests",
            r#"{"error":{"code":"RATE_LIMITED","message":"Too many requests"}}"#,
            "Too many requests. Please try again later.",
        ),
    ];
    for (status, response, want) in cases {
        let (_, result) = joined(true, status, response).await;
        assert_eq!(result.error.as_deref(), Some(want), "{status} {response}");
    }
}

#[tokio::test]
async fn uninitialized_telemetry_is_a_failed_join_that_sends_nothing() {
    let result = join(
        NativeTransport::loopback().as_ref(),
        "http://127.0.0.1:9/ios-beta/join",
        input("me@example.com"),
        None,
    )
    .await;
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("TELEMETRY_NOT_INITIALIZED"));
}

/// zod 4's `.email()` after `.trim()`, then `.max(254)`, as `IosBetaJoinInputSchema` reads it.
/// A rejected address never leaves the device, so it never spends one of the server's 5 an hour.
#[tokio::test]
async fn the_email_check_is_the_server_schema() {
    let dir = tempfile::tempdir().expect("dir");
    let service = telemetry(dir.path(), true);
    let long = format!("{}@example.com", "a".repeat(242));
    let too_long = format!("{}@example.com", "a".repeat(243));
    let rejected = [
        "not an email",
        "a..b@x.co",
        ".a@x.co",
        "a.@x.co",
        "a@x.c",
        "a@x.co1",
        "a@-x.co",
        "a@x_y.co",
        "a@x..co",
        "a@.x.co",
        "a@x",
        "@x.co",
        "a b@x.co",
        "a\"b@x.co",
        "ü@x.co",
        "a@ü.co",
        "a@b@x.co",
        too_long.as_str(),
    ];
    for email in rejected {
        let result = join(
            NativeTransport::loopback().as_ref(),
            "http://127.0.0.1:9/ios-beta/join",
            input(email),
            Some(&service),
        )
        .await;
        assert_eq!(
            result.error.as_deref(),
            Some("INVALID_IOS_BETA_JOIN"),
            "{email}"
        );
    }
    // Accepted addresses go to a port nothing listens on, so they fail on the network instead.
    let accepted = [
        "a@x.co",
        " a@x.co ",
        "a.b@x.co",
        "a'b+c_d-e@x.co",
        "a+@x.co",
        "A@sub.X-y.example.COM",
        long.as_str(),
    ];
    for email in accepted {
        let result = join(
            NativeTransport::loopback().as_ref(),
            "http://127.0.0.1:9/ios-beta/join",
            input(email),
            Some(&service),
        )
        .await;
        assert_ne!(
            result.error.as_deref(),
            Some("INVALID_IOS_BETA_JOIN"),
            "{email}"
        );
    }
}
