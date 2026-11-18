//! A local stand-in for the Readwise API: answers each request from a script and records what
//! it was asked. Shared by `readwise_client.rs` and `readwise_run.rs`.

#![allow(dead_code, reason = "each test binary uses a part of it")]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::readwise::client::ReadwiseClient;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use url::Url;

#[derive(Debug, Clone)]
pub struct Seen {
    pub target: String,
    pub authorization: Option<String>,
}

impl Seen {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    pub fn query(&self) -> Vec<(String, String)> {
        let url = Url::parse(&format!("http://h{}", self.target)).unwrap();
        url.query_pairs().into_owned().collect()
    }

    pub fn param(&self, name: &str) -> Option<String> {
        self.query()
            .into_iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }
}

pub enum Reply {
    Answer {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// Closes the connection without answering.
    Hangup,
    /// Declares a body of this many bytes and closes the connection without sending it.
    Declared(usize),
    /// Reads the request and never answers, holding the connection.
    Stall,
}

impl Reply {
    pub fn json(status: u16, value: &Value) -> Self {
        Self::Answer {
            status,
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }

    pub fn status(status: u16) -> Self {
        Self::Answer {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn page(results: Value, next: Option<&str>) -> Self {
        Self::json(200, &json!({ "results": results, "nextPageCursor": next }))
    }

    pub fn retry_after(value: Option<&str>) -> Self {
        Self::Answer {
            status: 429,
            headers: value
                .map(|v| ("retry-after", v.to_owned()))
                .into_iter()
                .collect(),
            body: Vec::new(),
        }
    }
}

pub type Script = Arc<dyn Fn(&Seen, usize) -> Reply + Send + Sync>;

pub struct Server {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    pub async fn start(script: impl Fn(&Seen, usize) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let script: Script = Arc::new(script);
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (script, log) = (Arc::clone(&script), Arc::clone(&log));
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&head).into_owned();
                    let mut lines = head.split("\r\n");
                    let target = lines.next().unwrap().split(' ').nth(1).unwrap().to_owned();
                    let authorization = lines
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                        .map(|(_, value)| value.trim().to_owned());
                    let seen = Seen {
                        target,
                        authorization,
                    };
                    let n = {
                        let mut log = log.lock().unwrap();
                        log.push(seen.clone());
                        log.len() - 1
                    };
                    let response = match script(&seen, n) {
                        Reply::Hangup => return,
                        Reply::Stall => {
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                            return;
                        }
                        Reply::Declared(len) => format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n"
                        )
                        .into_bytes(),
                        Reply::Answer {
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
                            let mut out = out.into_bytes();
                            out.extend_from_slice(&body);
                            out
                        }
                    };
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { addr, seen }
    }

    pub fn client(&self) -> ReadwiseClient {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = memry_desktop::http::builder().no_proxy().build().unwrap();
        ReadwiseClient::with_origin(http, Url::parse(&format!("http://{}", self.addr)).unwrap())
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}
