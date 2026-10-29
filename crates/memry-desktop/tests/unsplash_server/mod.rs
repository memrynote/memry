//! A local TLS server standing in for `api.unsplash.com` and the image CDN. The real `reqwest`
//! client resolves the real host names to it, so production URLs, the host allowlist, the redirect
//! check and the timeouts all run unchanged.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use memry_desktop::notes::unsplash::Unsplash;
use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub const HOSTS: [&str; 4] = [
    "api.unsplash.com",
    "images.unsplash.com",
    "plus.unsplash.com",
    "other.example",
];

#[derive(Debug, Clone)]
pub struct Seen {
    pub host: String,
    pub target: String,
    pub authorization: Option<String>,
    pub accept_version: Option<String>,
}

pub enum Reply {
    Ok {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// Closes the connection without answering.
    Hangup,
    /// `head`, `bytes` bytes of `0x78`, then `tail`, with no `Content-Length`, ended by closing
    /// the connection.
    Undeclared {
        head: &'static str,
        bytes: usize,
        tail: &'static str,
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

pub async fn serve(respond: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Harness {
    let _ = rustls::crypto::ring::default_provider().install_default();
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
    let respond = Arc::new(respond);
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let (acceptor, respond, log) =
                (acceptor.clone(), Arc::clone(&respond), Arc::clone(&log));
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let mut head = Vec::new();
                let mut chunk = [0u8; 2048];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match tls.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&chunk[..n]),
                    }
                }
                let seen = parse(&String::from_utf8_lossy(&head));
                log.lock().expect("log").push(seen.clone());
                match respond(&seen) {
                    Reply::Hangup => {}
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
                        let _ = tls.write_all(out.as_bytes()).await;
                        let _ = tls.write_all(&body).await;
                    }
                    Reply::Undeclared { head, bytes, tail } => {
                        let _ = tls
                            .write_all(b"HTTP/1.1 200 X\r\ncontent-type: image/jpeg\r\nconnection: close\r\n\r\n")
                            .await;
                        let _ = tls.write_all(head.as_bytes()).await;
                        let block = vec![b'x'; 64 * 1024];
                        let mut sent = 0;
                        while sent < bytes {
                            let n = block.len().min(bytes - sent);
                            if tls.write_all(&block[..n]).await.is_err() {
                                return;
                            }
                            sent += n;
                        }
                        let _ = tls.write_all(tail.as_bytes()).await;
                    }
                }
                let _ = tls.shutdown().await;
            });
        }
    });
    Harness { root, addr, seen }
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
    }
}
