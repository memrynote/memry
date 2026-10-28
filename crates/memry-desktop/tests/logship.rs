//! Log shipping end to end: warn and error records are redacted, throttled and shipped to a
//! local server; info, the pipeline's own scopes and a disabled setting ship nothing.

use memry_desktop::telemetry::logship::{self, Deps, ShipLayer};
use memry_desktop::telemetry::service::{Context, Sender};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing_subscriber::layer::SubscriberExt;

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

#[tokio::test]
async fn warnings_are_redacted_throttled_shipped_and_off_ships_nothing() {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().expect("tmp");
    let (url, mut seen) = server("204 No Content").await;
    let ship = logship::install(Deps {
        context: Context {
            install_id: "11111111-1111-4111-8111-111111111111".into(),
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            app_version: "1.0.0".into(),
            build_channel: "staging".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            locale: "en".into(),
            timezone_offset_minutes: 0,
        },
        sender: Sender::new(
            url,
            memry_desktop::seams::transport::NativeTransport::loopback(),
        ),
        salt: "0123456789abcdef0123456789abcdef".into(),
        level: None,
        ships: true,
        enabled: true,
        queue_path: dir.path().join(logship::LOG_QUEUE_FILE),
    });

    let subscriber = tracing_subscriber::registry().with(ShipLayer);
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(scope = "Sync", "not shipped: below warn");
        tracing::warn!(
            scope = "Sync",
            "cannot read /Users/kaan/secret.md for kaan@example.com"
        );
        tracing::warn!(
            scope = "Sync",
            "cannot read /Users/kaan/secret.md for kaan@example.com"
        );
        tracing::error!(scope = "Notes", retries = 3u64, "write failed");
        tracing::warn!(scope = "LogShip", "the pipeline's own scope is skipped");
    });

    assert_eq!(ship.queue_depth(), 2);
    let result = ship.flush().await;
    assert!(result.success && result.accepted == 2, "{result:?}");
    let body: serde_json::Value =
        serde_json::from_str(&seen.recv().await.expect("body")).expect("json");
    assert_eq!(body["schemaVersion"], 1);
    assert_eq!(body["buildChannel"], "staging");
    let lines = body["lines"].as_array().expect("lines");
    assert_eq!(lines.len(), 2);
    let text = lines[0]["message"].as_str().expect("message");
    assert!(!text.contains("kaan"), "{text}");
    assert_eq!(
        (lines[0]["level"].as_str(), lines[0]["scope"].as_str()),
        (Some("warn"), Some("Sync"))
    );
    assert_eq!(lines[1]["level"], "error");
    assert_eq!(
        lines[1]["fields"]["retries"], "3",
        "an unlisted numeric field ships as redacted text"
    );
    // The repeat only counted; the ring holds both lines with the count on the first.
    let ring = ship.recent_lines();
    assert_eq!(ring.len(), 2);

    ship.set_enabled(false);
    tracing::subscriber::with_default(tracing_subscriber::registry().with(ShipLayer), || {
        tracing::warn!(scope = "Sync", "after the opt-out");
    });
    assert_eq!(ship.queue_depth(), 0);
    assert_eq!(ship.flush().await.attempted, 0);
    assert!(!dir.path().join(logship::LOG_QUEUE_FILE).exists());
}
