//! The model download never goes through a proxy, as Electron's fetch never does (#4450): with
//! `HTTP_PROXY` and `ALL_PROXY` pointing at a listener, the request still reaches the host
//! directly. Its own process: it sets proxy variables for the whole process.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use memry_desktop::embedding::download::{Abort, ModelSource, PinnedFile};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const BODY: &[u8] = b"the pinned model file";

/// Answers every connection with `body` and counts them.
async fn listen(body: &'static [u8]) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let header = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(body).await;
            });
        }
    });
    (url, hits)
}

#[tokio::test]
async fn the_download_ignores_proxy_variables() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (host, host_hits) = listen(BODY).await;
    let (proxy, proxy_hits) = listen(b"not the model file!!!").await;
    for name in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        // SAFETY: this test binary runs this one test, before any thread reads the environment.
        unsafe { std::env::set_var(name, &proxy) };
    }
    let dir = tempfile::tempdir().unwrap();
    let file = PinnedFile {
        path: "model.bin".to_owned(),
        size: BODY.len() as u64,
        sha256: hex::encode(Sha256::digest(BODY)),
    };
    let source = ModelSource::new(
        &host,
        "repo/model",
        "rev",
        dir.path().to_path_buf(),
        vec![file],
    );
    let abort = Abort {
        cancel: CancellationToken::new(),
        deadline: Instant::now() + Duration::from_secs(60),
    };
    source.ensure(&abort, &|_| {}).await.expect("downloaded");

    assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), BODY);
    assert_eq!(host_hits.load(Ordering::SeqCst), 1);
    assert_eq!(proxy_hits.load(Ordering::SeqCst), 0);
}
