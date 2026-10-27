use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::*;
use crate::shell::loopback_route::encode_media_target;

struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn send(port: u16, method: &str, host: &str, path: &str, extra: &[(&str, &str)]) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in extra {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(": "))
        .map(|(n, v)| (n.to_ascii_lowercase(), v.to_owned()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    if headers
        .get("transfer-encoding")
        .is_some_and(|v| v == "chunked")
    {
        body = dechunk(&body);
    }
    Reply {
        status,
        headers,
        body,
    }
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n").unwrap();
        let size =
            usize::from_str_radix(std::str::from_utf8(&data[..line_end]).unwrap(), 16).unwrap();
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[line_end + 2..line_end + 2 + size]);
        data = &data[line_end + 2 + size + 2..];
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    server: LoopbackServer,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    let vault = base.join("vault");
    let data = base.join("data");
    fs::create_dir_all(vault.join("attachments/n1")).unwrap();
    fs::create_dir_all(&data).unwrap();
    let roots = Roots {
        vault: Some(vault.clone()),
        app_data: data,
        app_origins: vec!["tauri://localhost".to_owned()],
        reply_origin: "tauri://localhost".to_owned(),
    };
    let server = start(Arc::new(move || roots.clone()), false).await.unwrap();
    Fixture {
        _dir: dir,
        vault,
        server,
    }
}

impl Fixture {
    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.server.port())
    }

    fn media_path(&self, file: &std::path::Path) -> String {
        let url = format!("memry-file://local{}", file.to_string_lossy());
        format!("/m/{}/{}", self.server.token(), encode_media_target(&url))
    }
}

#[tokio::test]
async fn streams_a_file_whole_and_by_range() {
    let fx = fixture().await;
    let file = fx.vault.join("attachments/n1/abc123-clip.mp4");
    let data: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    fs::write(&file, &data).unwrap();
    let path = fx.media_path(&file);

    let whole = send(fx.server.port(), "GET", &fx.host(), &path, &[]).await;
    assert_eq!(whole.status, 200);
    assert_eq!(whole.headers["content-type"], "video/mp4");
    assert_eq!(whole.headers["cache-control"], "no-store");
    assert_eq!(whole.body, data);

    let part = send(
        fx.server.port(),
        "GET",
        &fx.host(),
        &path,
        &[("Range", "bytes=1000-1999")],
    )
    .await;
    assert_eq!(part.status, 206);
    assert_eq!(
        part.headers["content-range"],
        format!("bytes 1000-1999/{}", data.len())
    );
    assert_eq!(part.body, data[1000..2000]);

    let tail = send(
        fx.server.port(),
        "GET",
        &fx.host(),
        &path,
        &[("Range", "bytes=-5")],
    )
    .await;
    assert_eq!(tail.body, data[data.len() - 5..]);

    let past = send(
        fx.server.port(),
        "GET",
        &fx.host(),
        &path,
        &[("Range", "bytes=99999999-")],
    )
    .await;
    assert_eq!(past.status, 416);
}

#[tokio::test]
async fn refuses_a_foreign_host_a_wrong_token_and_other_methods() {
    let fx = fixture().await;
    let file = fx.vault.join("attachments/n1/abc123-clip.mp4");
    fs::write(&file, b"x").unwrap();
    let path = fx.media_path(&file);
    let port = fx.server.port();

    let rebound = send(port, "GET", &format!("evil.example.com:{port}"), &path, &[]).await;
    assert_eq!(rebound.status, 403);
    let no_port = send(port, "GET", "127.0.0.1", &path, &[]).await;
    assert_eq!(no_port.status, 403);

    let wrong = path.replacen(fx.server.token(), &"0".repeat(64), 1);
    assert_eq!(send(port, "GET", &fx.host(), &wrong, &[]).await.status, 404);
    assert_eq!(send(port, "GET", &fx.host(), "/", &[]).await.status, 404);

    assert_eq!(send(port, "POST", &fx.host(), &path, &[]).await.status, 405);
    assert_eq!(send(port, "HEAD", &fx.host(), &path, &[]).await.status, 405);
}

#[tokio::test]
async fn a_valid_token_still_cannot_read_outside_the_roots() {
    let fx = fixture().await;
    let secret = fx.vault.parent().unwrap().join("secret.txt");
    fs::write(&secret, b"secret").unwrap();
    let reply = send(
        fx.server.port(),
        "GET",
        &fx.host(),
        &fx.media_path(&secret),
        &[],
    )
    .await;
    assert_eq!(reply.status, 403);
    assert!(reply.body.is_empty());

    let other = format!(
        "/m/{}/{}",
        fx.server.token(),
        encode_media_target("file:///etc/passwd")
    );
    assert_eq!(
        send(fx.server.port(), "GET", &fx.host(), &other, &[])
            .await
            .status,
        404
    );
}

#[tokio::test]
async fn the_youtube_page_carries_the_restrictive_policy() {
    let fx = fixture().await;
    let path = format!("/e/{}/youtube/dQw4w9WgXcQ", fx.server.token());
    let reply = send(fx.server.port(), "GET", &fx.host(), &path, &[]).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.headers["content-security-policy"], EMBED_CSP);
    assert_eq!(reply.headers["content-type"], "text/html; charset=utf-8");
    let html = String::from_utf8(reply.body).unwrap();
    assert!(html.contains("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
}

#[tokio::test]
async fn each_server_has_its_own_port_and_token() {
    let a = fixture().await;
    let b = fixture().await;
    assert_ne!(a.server.port(), b.server.port());
    assert_ne!(a.server.token(), b.server.token());
    assert_eq!(a.server.token().len(), 64);
    assert!(a.server.origin().starts_with("http://127.0.0.1:"));
}

#[tokio::test]
async fn a_dropped_server_stops_listening() {
    let fx = fixture().await;
    let port = fx.server.port();
    drop(fx);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

#[tokio::test]
async fn a_file_is_sandboxed_and_readable_only_by_the_app_origin() {
    let fx = fixture().await;
    let file = fx.vault.join("attachments/n1/abc123-pic.svg");
    fs::write(&file, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
    let path = fx.media_path(&file);
    let port = fx.server.port();

    // An SVG opened at its own URL is a document: it gets no scripts and an opaque origin, so
    // it cannot read the token out of the page that links it.
    let plain = send(port, "GET", &fx.host(), &path, &[]).await;
    assert_eq!(plain.status, 200);
    assert_eq!(
        plain.headers["content-security-policy"],
        "sandbox; default-src 'none'"
    );
    assert_eq!(
        plain.headers["access-control-allow-origin"],
        "tauri://localhost"
    );

    let app = send(
        port,
        "GET",
        &fx.host(),
        &path,
        &[("Origin", "tauri://localhost")],
    )
    .await;
    assert_eq!(
        app.headers["access-control-allow-origin"],
        "tauri://localhost"
    );

    for origin in ["null", "https://evil.example"] {
        let refused = send(port, "GET", &fx.host(), &path, &[("Origin", origin)]).await;
        assert_eq!(refused.status, 403, "{origin}");
        assert!(!refused.headers.contains_key("access-control-allow-origin"));
    }
}

#[tokio::test]
async fn the_embed_page_switches_the_devices_off_for_the_player_it_nests() {
    let fx = fixture().await;
    let path = format!("/e/{}/youtube/dQw4w9WgXcQ", fx.server.token());
    let page = send(fx.server.port(), "GET", &fx.host(), &path, &[]).await;
    assert_eq!(page.status, 200);
    let policy = &page.headers["permissions-policy"];
    assert!(policy.contains("microphone=()") && policy.contains("camera=()"));
}
