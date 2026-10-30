//! The flush path against a real local HTTP server: what a 2xx, a 4xx, a 429 and a dead
//! endpoint each do to the queue, and that off means nothing is sent or kept.

use std::path::Path;

use memry_desktop::telemetry::service::{Context, FlushReason, Sender, Service};
use memry_desktop::updater::webview2::Outcome;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn server(status: &'static str) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!(
        "http://{}/telemetry/batch",
        listener.local_addr().expect("addr")
    );
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 1 << 20];
            let mut total = 0;
            loop {
                let n = socket.read(&mut buf[total..]).await.unwrap_or(0);
                total += n;
                let text = String::from_utf8_lossy(&buf[..total]).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let want = head
                        .to_lowercase()
                        .split("content-length: ")
                        .nth(1)
                        .and_then(|r| r.split("\r\n").next()?.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= want || n == 0 {
                        let _ = tx.send(body.to_owned());
                        break;
                    }
                } else if n == 0 {
                    break;
                }
            }
            let _ = socket
                .write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await;
        }
    });
    (url, rx)
}

fn service(dir: impl AsRef<Path>, url: &str, enabled: bool) -> Service {
    let context = Context {
        install_id: "11111111-1111-4111-8111-111111111111".into(),
        session_id: "s".into(),
        app_version: "1.0.0".into(),
        build_channel: "production".into(),
        platform: "linux".into(),
        arch: "x64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    // The shell installs this at boot (`install_crypto_provider`).
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    Service::start(
        dir.as_ref(),
        context,
        Sender::new(
            url,
            memry_desktop::seams::transport::NativeTransport::loopback(),
        ),
        enabled,
    )
}

fn track(service: &Service, count: usize) {
    for _ in 0..count {
        service.track(Service::event("app_started", "app", "start"));
    }
}

#[tokio::test]
async fn an_accepted_batch_of_fifty_leaves_the_rest_queued_and_journaled() {
    let dir = tempfile::tempdir().expect("tmp");
    let (url, mut seen) = server("204 No Content").await;
    let first = service(&dir, &url, true);
    track(&first, 60);
    let result = first.flush(FlushReason::Manual).await;
    assert!(result.success && result.accepted == 50, "{result:?}");
    let body: serde_json::Value =
        serde_json::from_str(&seen.recv().await.expect("body")).expect("json");
    assert_eq!(body["events"].as_array().expect("events").len(), 50);
    assert_eq!(body["clientQueueDepth"], 60);
    assert_eq!(first.queue_depth(), 10);
    // A restart sees exactly the ten left.
    assert_eq!(service(&dir, &url, true).queue_depth(), 10);
}

#[tokio::test]
async fn a_client_error_drops_the_batch_but_429_and_a_dead_endpoint_keep_it() {
    let dir = tempfile::tempdir().expect("tmp");
    let (bad, _rx) = server("400 Bad Request").await;
    let s = service(&dir, &bad, true);
    track(&s, 3);
    assert!(!s.flush(FlushReason::Manual).await.success);
    assert_eq!(s.queue_depth(), 0);

    let (busy, _rx2) = server("429 Too Many Requests").await;
    let s = service(&dir, &busy, true);
    track(&s, 3);
    assert!(!s.flush(FlushReason::Manual).await.success);
    assert_eq!(s.queue_depth(), 3);

    let dead_dir = tempfile::tempdir().expect("tmp");
    let dead = service(&dead_dir, "http://127.0.0.1:1/x", true);
    track(&dead, 2);
    assert!(dead.flush(FlushReason::Manual).await.error.is_some());
    assert_eq!(dead.queue_depth(), 2);
}

#[tokio::test]
async fn off_sends_nothing_keeps_nothing_and_removes_the_mirror() {
    let dir = tempfile::tempdir().expect("tmp");
    let (url, _rx) = server("204 No Content").await;
    let s = service(&dir, &url, true);
    track(&s, 2);
    assert!(dir.path().join("telemetry-event-queue.json").exists());
    s.set_enabled(false);
    track(&s, 2);
    assert_eq!(s.queue_depth(), 0);
    assert!(!dir.path().join("telemetry-event-queue.json").exists());
    assert_eq!(s.flush(FlushReason::Manual).await.attempted, 0);
    assert_eq!(s.config().enabled(), Some(false));
}

#[tokio::test]
async fn events_written_before_the_service_started_ship_with_the_next_launch() {
    let dir = tempfile::tempdir().expect("tmp");
    let (url, mut seen) = server("204 No Content").await;
    // A new install whose first launch stopped at the WebView2 check: no data directory yet.
    let fresh = dir.path().join("first-launch");
    Service::queue_for_next_launch(&fresh, Outcome::Missing.event().expect("event"));
    let next = service(&fresh, &url, true);
    assert!(next.flush(FlushReason::Manual).await.success);
    let body: serde_json::Value =
        serde_json::from_str(&seen.recv().await.expect("body")).expect("json");
    assert_eq!(body["events"][0]["errorCode"], "WEBVIEW2_MISSING");

    // A journal the last run left keeps its events, and the new one goes last.
    track(&next, 2);
    drop(next);
    Service::queue_for_next_launch(&fresh, Outcome::InstallFailed.event().expect("event"));
    let queued = service(&fresh, &url, true).queued();
    assert_eq!(queued.len(), 3);
    assert_eq!(
        queued[2].error_code.as_deref(),
        Some("WEBVIEW2_INSTALL_FAILED")
    );
}
