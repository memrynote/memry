//! `OneShotCallback` over real sockets with a local HTTP client: one answer for the expected
//! state, 404 elsewhere, refusals that keep the wait going, and the expiry on a paused clock
//! (`apps/desktop/src/main/ipc/auth-oauth-handlers.ts:155-189`).

use std::time::Duration;

use futures_util::FutureExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use memry_desktop::oauth::loopback::{CallbackOutcome, ERROR_HTML, OneShotCallback, SUCCESS_HTML};

const TTL: Duration = Duration::from_secs(10 * 60);

/// One `GET` over a fresh connection, as a browser tab sends it: `(status, body)`.
pub(crate) async fn get(url: &str) -> std::io::Result<(u16, String)> {
    let rest = url.trim_start_matches("http://");
    let (address, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let path = if path.is_empty() { "/" } else { path };
    let mut stream = TcpStream::connect(address).await?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).await?;
    let status = reply
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| std::io::Error::other(format!("no status line in {reply:?}")))?;
    let body = reply
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, body))
}

fn origin(callback: &OneShotCallback) -> String {
    callback
        .redirect_uri()
        .trim_end_matches("/callback")
        .to_owned()
}

#[tokio::test]
async fn the_first_callback_for_the_state_is_the_answer_and_the_server_closes() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let uri = callback.redirect_uri();
    assert!(
        uri.starts_with("http://127.0.0.1:") && uri.ends_with("/callback"),
        "{uri}"
    );
    callback.expect_state("s-1");

    let (status, body) = get(&format!("{uri}?code=c-1&state=s-1")).await.unwrap();
    assert_eq!((status, body.as_str()), (200, SUCCESS_HTML));
    // A second delivery of the same redirect, while the attempt is still held, finds it spent.
    match get(&format!("{uri}?code=c-1&state=s-1")).await {
        Ok((status, _)) => assert_ne!(status, 200, "a second callback was taken"),
        Err(_) => {} // nothing listens any more
    }
    assert_eq!(
        callback.outcome().await,
        CallbackOutcome::Code {
            code: "c-1".into(),
            state: "s-1".into()
        }
    );
}

#[tokio::test]
async fn other_paths_and_other_states_are_refused_and_the_wait_goes_on() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let uri = callback.redirect_uri();
    let base = origin(&callback);

    // Before the attempt names its state, nothing is taken.
    let (status, body) = get(&format!("{uri}?code=c&state=s-2")).await.unwrap();
    assert_eq!((status, body.as_str()), (400, ERROR_HTML));
    callback.expect_state("s-2");

    let (status, body) = get(&format!("{base}/")).await.unwrap();
    assert_eq!((status, body.as_str()), (404, ""));
    let (status, _) = get(&format!("{base}/callback/x?code=c&state=s-2"))
        .await
        .unwrap();
    assert_eq!(status, 404);
    let (status, body) = get(&format!("{uri}?code=c&state=forged")).await.unwrap();
    assert_eq!((status, body.as_str()), (400, ERROR_HTML));
    let (status, _) = get(&format!("{uri}?state=s-2")).await.unwrap();
    assert_eq!(status, 400, "a callback with no code is refused");
    let (status, _) = get(&format!("{uri}?code=&state=s-2")).await.unwrap();
    assert_eq!(status, 400, "an empty code is refused");

    let (status, body) = get(&format!("{uri}?code=c-2&state=s-2")).await.unwrap();
    assert_eq!((status, body.as_str()), (200, SUCCESS_HTML));
    assert_eq!(
        callback.outcome().await,
        CallbackOutcome::Code {
            code: "c-2".into(),
            state: "s-2".into()
        }
    );
}

#[tokio::test]
async fn a_provider_error_for_the_state_ends_the_wait_as_denied() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let uri = callback.redirect_uri();
    callback.expect_state("s-3");

    let (status, body) = get(&format!("{uri}?error=access_denied&state=s-3"))
        .await
        .unwrap();
    assert_eq!((status, body.as_str()), (200, ERROR_HTML));
    assert_eq!(callback.outcome().await, CallbackOutcome::Denied);
}

#[tokio::test]
async fn a_provider_error_for_another_state_does_not_end_the_wait() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let uri = callback.redirect_uri();
    callback.expect_state("s-4");

    let (status, _) = get(&format!("{uri}?error=access_denied&state=forged"))
        .await
        .unwrap();
    assert_eq!(status, 400);
    let (status, _) = get(&format!("{uri}?code=c-4&state=s-4")).await.unwrap();
    assert_eq!(status, 200);
    assert!(matches!(
        callback.outcome().await,
        CallbackOutcome::Code { .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn with_no_callback_the_wait_expires_at_its_time_to_live_and_the_server_closes() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let address = callback
        .redirect_uri()
        .trim_start_matches("http://")
        .trim_end_matches("/callback")
        .to_owned();
    callback.expect_state("s-5");

    tokio::time::advance(TTL).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    assert_eq!(
        callback.outcome().now_or_never(),
        Some(CallbackOutcome::Expired),
        "the wait did not end at its time to live"
    );
    assert!(
        std::net::TcpStream::connect(&address).is_err(),
        "the loopback still listens after the expiry"
    );
}

#[tokio::test(start_paused = true)]
async fn the_wait_does_not_expire_before_its_time_to_live() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let uri = callback.redirect_uri();
    callback.expect_state("s-6");
    tokio::time::advance(TTL - Duration::from_secs(1)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    let address = uri
        .trim_start_matches("http://")
        .trim_end_matches("/callback")
        .to_owned();
    assert!(
        std::net::TcpStream::connect(&address).is_ok(),
        "the loopback closed before its time to live"
    );
    drop(callback);
}

#[tokio::test]
async fn dropping_the_callback_closes_the_server() {
    let callback = OneShotCallback::bind(TTL).await.unwrap();
    let address = callback
        .redirect_uri()
        .trim_start_matches("http://")
        .trim_end_matches("/callback")
        .to_owned();
    drop(callback);
    tokio::task::yield_now().await;
    let mut closed = false;
    for _ in 0..100 {
        if std::net::TcpStream::connect(&address).is_err() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(closed, "the loopback still listens after the drop");
}
