//! Beta feedback and the incident report against a real local HTTP server: a refusal reaches the
//! renderer with the message Electron's handler returns, and the feedback email check is the
//! server's `FeedbackSubmitSchema`.

use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::report::{
    DiagnosticReport, DiagnosticSnapshot, DiagnosticTrigger, FeedbackSubmit, send_incident_report,
    submit_feedback,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Answers one request at `path` with `status` and `response`.
async fn server(path: &str, status: &'static str, response: &'static str) -> String {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://{}{path}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap_or(0);
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_lowercase();
            let done = text.split_once("\r\n\r\n").is_some_and(|(head, body)| {
                let want = head
                    .split("content-length: ")
                    .nth(1)
                    .and_then(|r| r.split("\r\n").next()?.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                body.len() >= want
            });
            if done || n == 0 {
                break;
            }
        }
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
    url
}

fn feedback(email: Option<&str>) -> FeedbackSubmit {
    FeedbackSubmit {
        message: "hi".into(),
        email: email.map(str::to_owned),
        app_version: None,
        platform: None,
    }
}

/// `feedback-handlers.ts` returns the `syncFetch` error message of `postToServer`.
#[tokio::test]
async fn refused_feedback_carries_the_server_message() {
    let cases: [(&'static str, &'static str, &str); 3] = [
        (
            "502 Bad Gateway",
            r#"{"error":{"code":"INTERNAL_ERROR","message":"Could not send feedback"}}"#,
            "Could not send feedback",
        ),
        ("500 Internal Server Error", "{}", "Server error (500)"),
        (
            "429 Too Many Requests",
            r#"{"error":"slow down"}"#,
            "Too many requests. Please try again later.",
        ),
    ];
    for (status, response, want) in cases {
        let url = server("/feedback", status, response).await;
        let result = submit_feedback(
            NativeTransport::loopback().as_ref(),
            &url,
            feedback(None),
            None,
        )
        .await;
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some(want), "{status} {response}");
    }
    let url = server("/feedback", "200 OK", r#"{"success":true}"#).await;
    let sent = submit_feedback(
        NativeTransport::loopback().as_ref(),
        &url,
        feedback(Some("a@x.co")),
        None,
    )
    .await;
    assert!(sent.success && sent.error.is_none(), "{sent:?}");
}

/// `FeedbackSubmitSchema`: `z.string().trim().email().max(320)`, so an address the server would
/// refuse never leaves the device.
#[test]
fn the_feedback_email_check_is_the_server_schema() {
    let long = format!("{}@{}.example.com", "a".repeat(64), "b".repeat(243));
    let too_long = format!("{}@{}.example.com", "a".repeat(64), "b".repeat(244));
    assert_eq!(long.chars().count(), 320);
    for email in [
        "a..b@x.co",
        ".a@x.co",
        "a.@x.co",
        "a@x.c",
        "a@-x.co",
        "a@x_y.co",
        "a\"b@x.co",
        "ü@x.co",
        "a@b@x.co",
        too_long.as_str(),
    ] {
        assert_eq!(
            feedback(Some(email)).validated(),
            Err("INVALID_FEEDBACK"),
            "{email}"
        );
    }
    for email in [" a@x.co ", "a'b+c_d-e@x.co", long.as_str()] {
        assert!(feedback(Some(email)).validated().is_ok(), "{email}");
    }
}

fn incident() -> DiagnosticReport {
    DiagnosticReport {
        schema_version: 1,
        install_id: "i".into(),
        session_id: "s".into(),
        app_version: "1.0.0".into(),
        build_channel: "production".into(),
        platform: "darwin".into(),
        arch: "arm64".into(),
        incident_id: "MEMRY-ABCDEFGH".into(),
        trigger: DiagnosticTrigger {
            source: "renderer".into(),
            error_code: None,
            stack: None,
        },
        snapshot: DiagnosticSnapshot {
            app_version: "1.0.0".into(),
            build_channel: "production".into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
            locale: "en".into(),
            uptime_seconds: 1.0,
            sync_enabled: false,
            sync_state: "disabled".into(),
            queue_depth: 0,
            vault_open: false,
            auth_state: "anonymous".into(),
        },
        lines: vec![],
    }
}

/// `sendIncidentReport` (`diagnostics/incident-report.ts`) posts with plain fetch, not
/// `syncFetch`, and throws `Failed to send incident report (status N)`.
#[tokio::test]
async fn a_refused_incident_report_names_the_status_as_electron_does() {
    let url = server(
        "/diagnostics/report",
        "400 Bad Request",
        r#"{"error":"bad"}"#,
    )
    .await;
    let refused =
        send_incident_report(NativeTransport::loopback().as_ref(), &url, &incident()).await;
    assert_eq!(
        refused,
        Err("Failed to send incident report (status 400)".to_owned())
    );
    let url = server("/diagnostics/report", "202 Accepted", "{}").await;
    let sent = send_incident_report(NativeTransport::loopback().as_ref(), &url, &incident()).await;
    assert_eq!(sent, Ok(()));
}
