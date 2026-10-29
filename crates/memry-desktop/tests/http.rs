use std::sync::Arc;
use std::time::{Duration, Instant};

use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

fn install_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

struct Server {
    port: u16,
    root: reqwest::Certificate,
}

/// A local TLS server whose certificate is trusted only through the test root. `respond` gets
/// the raw request head and a writer.
async fn serve<F, Fut>(respond: F) -> Server
where
    F: Fn(
            String,
            tokio::io::WriteHalf<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>,
        ) -> Fut
        + Send
        + Sync
        + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    install_provider();
    let key = KeyPair::generate().expect("key pair");
    let cert = CertificateParams::new(vec!["localhost".to_owned()])
        .expect("params")
        .self_signed(&key)
        .expect("certificate");
    let root = reqwest::Certificate::from_der(cert.der()).expect("root");
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.der().to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .expect("server config");
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let respond = Arc::new(respond);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            let respond = Arc::clone(&respond);
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let (mut read, write) = tokio::io::split(tls);
                let mut head = vec![0u8; 4096];
                let Ok(n) = read.read(&mut head).await else {
                    return;
                };
                respond(String::from_utf8_lossy(&head[..n]).into_owned(), write).await;
            });
        }
    });
    Server { port, root }
}

#[tokio::test]
async fn requests_carry_the_memrynote_user_agent() {
    let server = serve(|head, mut write| async move {
        let agent = head
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("user-agent:"))
            .unwrap_or("")
            .to_owned();
        let body = agent.as_bytes();
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        let _ = write.write_all(reply.as_bytes()).await;
        let _ = write.write_all(body).await;
        let _ = write.shutdown().await;
    })
    .await;
    let client = memry_desktop::http::client_trusting(server.root);
    let text = client
        .get(format!("https://localhost:{}/", server.port))
        .send()
        .await
        .expect("response")
        .text()
        .await
        .expect("body");
    assert!(
        text.to_ascii_lowercase()
            .ends_with(&format!("memrynote/{}", env!("CARGO_PKG_VERSION"))),
        "user agent header was: {text}"
    );
}

#[tokio::test]
async fn an_unroutable_address_fails_at_the_connect_timeout() {
    install_provider();
    let started = Instant::now();
    let error = memry_desktop::http::client()
        .get("https://10.255.255.1:81/")
        .send()
        .await
        .expect_err("nothing answers there");
    assert!(
        error.is_connect() || error.is_timeout(),
        "error was: {error}"
    );
    // timing-bound: the 10 s connect timeout fires; without it the OS gives up after 21 s
    // (Windows) to 75 s or more (macOS, Linux), and 20 s sits between them.
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_slow_body_is_not_cut_off() {
    let server = serve(|_head, mut write| async move {
        let _ = write
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\nconnection: close\r\n\r\nfirst")
            .await;
        let _ = write.flush().await;
        tokio::time::sleep(Duration::from_secs(11)).await;
        let _ = write.write_all(b"-last").await;
        let _ = write.shutdown().await;
    })
    .await;
    let client = memry_desktop::http::client_trusting(server.root);
    let body = client
        .get(format!("https://localhost:{}/", server.port))
        .send()
        .await
        .expect("response")
        .text()
        .await
        .expect("a body slower than the connect timeout is not cut off");
    assert_eq!(body, "first-last");
}

#[test]
fn the_dependency_tree_has_no_aws_lc_rs() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = std::process::Command::new(env!("CARGO"))
        .args([
            "tree",
            "-p",
            "memry-desktop",
            "-e",
            "features",
            "-i",
            "aws-lc-rs",
            "--manifest-path",
        ])
        .arg(manifest)
        .output()
        .expect("cargo tree runs");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success() && stderr.contains("did not match any packages"),
        "aws-lc-rs is in the tree.\nstdout: {}\nstderr: {stderr}",
        String::from_utf8_lossy(&output.stdout)
    );
}
