//! `ios_beta::join` against a real local HTTP server: the body the sync server's
//! `IosBetaJoinRequestSchema` reads, the install id only while telemetry is on, and a server
//! error as `success: false`.

use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::ios_beta::{IosBetaJoinInput, IosBetaSource, join};
use memry_desktop::telemetry::service::{Context, Sender, Service};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const INSTALL_ID: &str = "11111111-1111-4111-8111-111111111111";

/// Answers one request with `status` and hands back its path and body.
async fn server(
    status: &'static str,
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
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
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
) -> (Value, memry_desktop::telemetry::ios_beta::IosBetaJoinResult) {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().expect("dir");
    let (url, rx) = server(status).await;
    let result = join(
        NativeTransport::loopback().as_ref(),
        &url,
        input(" me@example.com "),
        &telemetry(dir.path(), enabled),
    )
    .await;
    let (path, body) = rx.await.expect("request");
    assert_eq!(path, "/ios-beta/join");
    (serde_json::from_str(&body).expect("json body"), result)
}

#[tokio::test]
async fn telemetry_on_sends_the_install_id() {
    let (body, result) = joined(true, "200 OK").await;
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
    let (body, result) = joined(false, "200 OK").await;
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

#[tokio::test]
async fn a_server_error_is_a_failed_join() {
    let (_, result) = joined(true, "502 Bad Gateway").await;
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("status 502"));
}

#[tokio::test]
async fn an_invalid_email_never_leaves_the_device() {
    let dir = tempfile::tempdir().expect("dir");
    let result = join(
        NativeTransport::loopback().as_ref(),
        "http://127.0.0.1:9/ios-beta/join",
        input("not an email"),
        &telemetry(dir.path(), true),
    )
    .await;
    assert_eq!(result.error.as_deref(), Some("INVALID_IOS_BETA_JOIN"));
}
