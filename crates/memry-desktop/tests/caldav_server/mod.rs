//! A local TLS server standing in for CalDAV servers (an iCloud-shaped discovery host and
//! partition host, a self-hosted server, two hosts under one dynamic-DNS suffix, and a host off the
//! account). The real `reqwest` client resolves those names to it, so the transport's redirect
//! and credential rules run unchanged. Unlike `unsplash_server`, it records each request's method,
//! `Depth` and body, which tell the WebDAV steps apart.

pub mod dav;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub const HOSTS: [&str; 6] = [
    "caldav.fastmail.com",
    "p67-caldav.fastmail.com",
    "dav.example",
    "evil.example",
    "myname.synology.me",
    "other.synology.me",
];

#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub host: String,
    pub target: String,
    pub depth: Option<String>,
    pub authorization: Option<String>,
    pub body: String,
}

pub enum Reply {
    Ok {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// Holds the connection open without answering.
    Stall,
    /// `then`, once the test notifies `gate`.
    Gated {
        gate: Arc<tokio::sync::Notify>,
        then: Box<Reply>,
    },
}

impl Reply {
    pub fn status(status: u16) -> Self {
        Self::Ok {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn redirect(status: u16, location: &str) -> Self {
        Self::status(status).with_header("location", location)
    }

    /// A `207 Multi-Status` answer.
    pub fn multistatus(body: String) -> Self {
        Self::Ok {
            status: 207,
            headers: vec![("content-type", "application/xml; charset=utf-8".to_owned())],
            body: body.into_bytes(),
        }
    }

    pub fn with_header(mut self, name: &'static str, value: &str) -> Self {
        if let Self::Ok { headers, .. } = &mut self {
            headers.push((name, value.to_owned()));
        }
        self
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

/// Reads one request (head and `Content-Length` body), records it, answers what `respond` says.
async fn answer<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    respond: &(dyn Fn(&Seen) -> Reply + Send + Sync),
    log: &Mutex<Vec<Seen>>,
) {
    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let length = header(&head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    while data.len() < head_end + length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
        }
    }
    let mut words = head.split_whitespace();
    let seen = Seen {
        method: words.next().unwrap_or_default().to_owned(),
        target: words.next().unwrap_or_default().to_owned(),
        host: header(&head, "host")
            .map(|h| h.split(':').next().unwrap_or_default().to_owned())
            .unwrap_or_default(),
        depth: header(&head, "depth"),
        authorization: header(&head, "authorization"),
        body: String::from_utf8_lossy(&data[head_end..head_end + length]).into_owned(),
    };
    log.lock().expect("log").push(seen.clone());
    let mut reply = respond(&seen);
    if let Reply::Gated { gate, then } = reply {
        gate.notified().await;
        reply = *then;
    }
    match reply {
        Reply::Stall => std::future::pending::<()>().await,
        Reply::Gated { .. } => {}
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
    }
    let _ = stream.shutdown().await;
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}
