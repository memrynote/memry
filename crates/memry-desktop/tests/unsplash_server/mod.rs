//! A local TLS server standing in for `api.unsplash.com` and the image CDN. The real `reqwest`
//! client resolves the real host names to it, so production URLs, the host allowlist, the redirect
//! check and the timeouts all run unchanged. The calendar feed tests use it for `feeds.example`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use memry_desktop::notes::unsplash::Unsplash;
use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub const HOSTS: [&str; 5] = [
    "api.unsplash.com",
    "images.unsplash.com",
    "plus.unsplash.com",
    "other.example",
    "feeds.example",
];

#[derive(Debug, Clone)]
pub struct Seen {
    pub host: String,
    pub target: String,
    pub authorization: Option<String>,
    pub accept_version: Option<String>,
    pub accept: Option<String>,
    pub if_none_match: Option<String>,
    pub if_modified_since: Option<String>,
}

pub enum Reply {
    Ok {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// Closes the connection without answering.
    Hangup,
    /// Holds the connection open without answering.
    Stall,
    /// `head`, `bytes` bytes of `0x78`, then `tail`, with no `Content-Length`, ended by closing
    /// the connection.
    Undeclared {
        head: &'static str,
        bytes: usize,
        tail: &'static str,
    },
    /// `then`, once the test notifies `gate`. Waits without blocking a runtime worker.
    Gated {
        gate: Arc<tokio::sync::Notify>,
        then: Box<Reply>,
    },
}

impl Reply {
    pub fn json(value: &Value) -> Self {
        Self::Ok {
            status: 200,
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }

    pub fn status(status: u16) -> Self {
        Self::Ok {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &'static str, value: &str) -> Self {
        if let Self::Ok { headers, .. } = &mut self {
            headers.push((name, value.to_owned()));
        }
        self
    }

    pub fn image(content_type: &str, body: &[u8]) -> Self {
        Self::Ok {
            status: 200,
            headers: vec![("content-type", content_type.to_owned())],
            body: body.to_vec(),
        }
    }
}

pub struct Harness {
    root: reqwest::Certificate,
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Harness {
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen").clone()
    }

    pub fn service(&self, key: Option<&str>) -> Unsplash {
        Unsplash::new(self.builder(), key.map(str::to_owned)).expect("client")
    }

    /// The app's builder, trusting this server and resolving every host to it.
    pub fn builder(&self) -> reqwest::ClientBuilder {
        let mut builder = memry_desktop::http::builder()
            .add_root_certificate(self.root.clone())
            .no_proxy();
        for host in HOSTS {
            builder = builder.resolve(host, self.addr);
        }
        builder
    }
}

/// The `ring` provider as the process default, as the shell installs it at boot
/// (`install_crypto_provider`). [`serve`] calls it; a test that builds the app's HTTP client
/// without a server calls it first, since nextest runs each test in a process of its own.
pub fn install_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub async fn serve(respond: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Harness {
    install_provider();
    let key = KeyPair::generate().expect("key pair");
    let cert = CertificateParams::new(HOSTS.map(str::to_owned).to_vec())
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
    let addr = listener.local_addr().expect("addr");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let respond: Arc<dyn Fn(&Seen) -> Reply + Send + Sync> = Arc::new(respond);
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let (acceptor, respond, log) =
                (acceptor.clone(), Arc::clone(&respond), Arc::clone(&log));
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else {
                    return;
                };
                answer(tls, respond.as_ref(), &log).await;
            });
        }
    });
    Harness { root, addr, seen }
}

/// Reads one request head off `stream`, records it, and answers what `respond` says.
async fn answer<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    respond: &(dyn Fn(&Seen) -> Reply + Send + Sync),
    log: &Mutex<Vec<Seen>>,
) {
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&chunk[..n]),
        }
    }
    let seen = parse(&String::from_utf8_lossy(&head));
    log.lock().expect("log").push(seen.clone());
    let mut reply = respond(&seen);
    if let Reply::Gated { gate, then } = reply {
        gate.notified().await;
        reply = *then;
    }
    match reply {
        Reply::Hangup | Reply::Gated { .. } => {}
        Reply::Stall => std::future::pending::<()>().await,
        Reply::Ok {
            status,
            headers,
            body,
        } => {
            let mut out = format!(
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                body.len()
            );
            for (name, value) in headers {
                out.push_str(&format!("{name}: {value}\r\n"));
            }
            out.push_str("\r\n");
            let _ = stream.write_all(out.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        }
        Reply::Undeclared { head, bytes, tail } => {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 200 X\r\ncontent-type: image/jpeg\r\nconnection: close\r\n\r\n",
                )
                .await;
            let _ = stream.write_all(head.as_bytes()).await;
            let block = vec![b'x'; 64 * 1024];
            let mut sent = 0;
            while sent < bytes {
                let n = block.len().min(bytes - sent);
                if stream.write_all(&block[..n]).await.is_err() {
                    return;
                }
                sent += n;
            }
            let _ = stream.write_all(tail.as_bytes()).await;
        }
    }
    let _ = stream.shutdown().await;
    let _ = stream.shutdown().await;
}

/// A plain-HTTP server on `127.0.0.1`, for feeds served without TLS.
pub struct Plain {
    pub addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Plain {
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen").clone()
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }
}

pub async fn serve_plain(respond: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Plain {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let respond: Arc<dyn Fn(&Seen) -> Reply + Send + Sync> = Arc::new(respond);
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (respond, log) = (Arc::clone(&respond), Arc::clone(&log));
            tokio::spawn(async move { answer(tcp, respond.as_ref(), &log).await });
        }
    });
    Plain { addr, seen }
}

fn parse(head: &str) -> Seen {
    let header = |name: &str| {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    Seen {
        host: header("host").unwrap_or_default(),
        target: head
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_owned(),
        authorization: header("authorization"),
        accept_version: header("accept-version"),
        accept: header("accept"),
        if_none_match: header("if-none-match"),
        if_modified_since: header("if-modified-since"),
    }
}
