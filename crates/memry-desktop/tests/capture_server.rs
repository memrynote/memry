//! The capture server's routes over a real loopback socket against a real temp vault
//! (Step 27, #3544): every route, status and error code as Electron's `server.ts` and
//! `auth.ts` answer them, the 25 MiB body cap, the port probe, the loopback-only bind, the
//! `Host` check, and the untrusted `/capture` body.

use std::net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

use memry_desktop::services::capture::{self, BODY_LIMIT, auth, folders, ingest, schema};
use memry_test_kit::{on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::capture_support::{
    CHROME, Env, Filer, OTHER_CHROME, article, busy_port, env, req, runtime, send_raw,
};

/// How long a connect may wait before the address counts as unreachable.
const CONNECT: Duration = Duration::from_secs(3);
const AUTHED_ROUTES: [&str; 4] = ["/capture", "/folders", "/tags", "/pair/revoke"];

#[test]
fn ping_answers_anyone_and_reports_whether_the_origin_is_paired() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let ping = req("GET", "/ping").send(server.port()).await;
        assert_eq!(ping.status, 200);
        assert_eq!(
            ping.body,
            json!({ "app": "memry", "version": "1.2.3", "paired": false, "capabilities": ["folders"] })
        );
        assert_eq!(ping.header("content-type"), Some("application/json"));
        assert_eq!(ping.header("connection"), Some("close"));
        assert!(
            ping.headers
                .iter()
                .all(|(name, _)| !name.to_ascii_lowercase().starts_with("access-control")),
            "no CORS header: {:?}",
            ping.headers
        );
        e.paired(CHROME);
        let ping = req("GET", "/ping")
            .header("Origin", CHROME)
            .send(server.port())
            .await;
        assert_eq!(ping.body["paired"], true);
        let other = req("GET", "/ping")
            .header("Origin", OTHER_CHROME)
            .send(server.port())
            .await;
        assert_eq!(other.body["paired"], false);
    });
}

#[test]
fn only_the_exact_route_and_method_match() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        for (method, target) in [
            ("POST", "/ping"),
            ("GET", "/capture"),
            ("GET", "/folders"),
            ("OPTIONS", "/capture"),
            ("GET", "/ping?x=1"),
            ("GET", "/ping/"),
            ("POST", "/Capture"),
            ("GET", "/"),
        ] {
            let resp = req(method, target).send(port).await;
            assert_eq!(resp.refused(), (404, "not-found"), "{method} {target}");
        }
        // Absolute form: Node's `req.url` is the whole target, which is not `/ping`.
        let absolute = format!("http://127.0.0.1:{port}/ping");
        let resp = req("GET", &absolute).send(port).await;
        assert_eq!(resp.refused(), (404, "not-found"));
    });
}

#[test]
fn a_host_other_than_this_server_is_refused_before_any_route() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        for host in [
            "evil.example:80".to_owned(),
            format!("rebound.example:{port}"),
            format!("127.0.0.1:{}", port.wrapping_add(1)),
            "127.0.0.1".to_owned(),
            format!("127.0.0.2:{port}"),
            format!("[::1]:{port}"),
        ] {
            let ping = req("GET", "/ping")
                .no_host()
                .header("Host", &host)
                .send(port)
                .await;
            assert_eq!(ping.refused(), (403, "host-not-allowed"), "{host}");
            let capture = req("POST", "/capture")
                .no_host()
                .header("Host", &host)
                .authed(CHROME, &token)
                .json(&article("https://example.com/a"))
                .send(port)
                .await;
            assert_eq!(capture.refused(), (403, "host-not-allowed"), "{host}");
        }
        let missing = req("GET", "/ping").no_host().send(port).await;
        assert_eq!(missing.refused(), (403, "host-not-allowed"));
        for host in [format!("localhost:{port}"), format!("LocalHost:{port}")] {
            let ping = req("GET", "/ping")
                .no_host()
                .header("Host", &host)
                .send(port)
                .await;
            assert_eq!(ping.status, 200, "{host}");
        }
    });
}

#[test]
fn authed_routes_check_the_header_then_the_origin_then_the_token() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        let wrong_same_length = "0".repeat(token.len());
        let prefix = &token[..10];
        for route in AUTHED_ROUTES {
            let refused = |resp: crate::capture_support::Resp| resp.refused().1.to_owned();
            // No header outranks a foreign origin and a missing token.
            let r = req("POST", route)
                .header("Origin", "https://evil.example")
                .send(port)
                .await;
            assert_eq!(refused(r), "missing-capture-header", "{route}");
            let r = req("POST", route)
                .authed(CHROME, &token)
                .header("X-Memry-Capture", "1")
                .send(port)
                .await;
            assert_eq!(
                refused(r),
                "missing-capture-header",
                "{route}: joined `1, 1`"
            );
            let r = req("POST", route)
                .authed(CHROME, &token)
                .header("X-Memry-Capture", "true")
                .send(port)
                .await;
            assert_eq!(refused(r), "missing-capture-header", "{route}");
            for origin in [OTHER_CHROME, "https://evil.example", "null"] {
                let r = req("POST", route).authed(origin, &token).send(port).await;
                assert_eq!(refused(r), "origin-not-allowed", "{route} {origin}");
            }
            let r = req("POST", route)
                .header("X-Memry-Capture", "1")
                .header("Authorization", &format!("Bearer {token}"))
                .send(port)
                .await;
            assert_eq!(refused(r), "origin-not-allowed", "{route}: no origin");
            let r = req("POST", route)
                .authed(CHROME, &token)
                .header("Origin", CHROME)
                .send(port)
                .await;
            assert_eq!(refused(r), "origin-not-allowed", "{route}: joined origins");
            for bad in [wrong_same_length.as_str(), prefix, "", " "] {
                let r = req("POST", route).authed(CHROME, bad).send(port).await;
                assert_eq!(r.refused(), (401, "bad-token"), "{route} {bad:?}");
            }
            let r = req("POST", route)
                .header("Origin", CHROME)
                .header("X-Memry-Capture", "1")
                .header("Authorization", &format!("bearer {token}"))
                .send(port)
                .await;
            assert_eq!(r.refused(), (401, "bad-token"), "{route}: lowercase scheme");
            let r = req("POST", route)
                .header("Origin", CHROME)
                .header("X-Memry-Capture", "1")
                .send(port)
                .await;
            assert_eq!(r.refused(), (401, "bad-token"), "{route}: no authorization");
        }
    });
}

#[test]
fn a_closed_vault_is_503_after_auth_and_keeps_nothing() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        e.session.close();
        for route in ["/capture", "/folders", "/tags"] {
            let r = req("POST", route)
                .authed(CHROME, &token)
                .json(&article("https://example.com/closed"))
                .send(port)
                .await;
            assert_eq!(r.refused(), (503, "vault-closed"), "{route}");
            let r = req("POST", route)
                .authed(CHROME, "nope")
                .json(&article("https://example.com/closed"))
                .send(port)
                .await;
            assert_eq!(r.refused(), (401, "bad-token"), "{route}: auth first");
        }
        let ping = req("GET", "/ping").send(port).await;
        assert_eq!(ping.status, 200);
    });
}

fn padded_body(len: usize) -> Vec<u8> {
    let mut body = br#"{"pad":""#.to_vec();
    body.resize(len - 2, b'a');
    body.extend(br#""}"#);
    assert_eq!(body.len(), len);
    body
}

#[test]
fn a_capture_body_of_25_mib_is_read_and_one_byte_more_is_413() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let token = e.paired(CHROME);
        let at_limit = req("POST", "/capture")
            .authed(CHROME, &token)
            .body(padded_body(BODY_LIMIT))
            .send(server.port())
            .await;
        assert_eq!(at_limit.refused(), (422, "invalid-capture"));
        let over = req("POST", "/capture")
            .authed(CHROME, &token)
            .body(padded_body(BODY_LIMIT + 1))
            .send(server.port())
            .await;
        assert_eq!(over.refused(), (413, "payload-too-large"));
    });
}

#[test]
fn the_server_takes_the_next_port_when_one_is_busy() {
    let e = env();
    runtime().block_on(async {
        let (_busy, first) = busy_port().await;
        let server = capture::start_in(e.deps(None), first, 2).await.unwrap();
        assert_eq!(server.port(), first + 1);
        let ping = req("GET", "/ping").send(server.port()).await;
        assert_eq!(ping.status, 200);
        let none = capture::start_in(e.deps(None), first, 1)
            .await
            .err()
            .unwrap();
        assert_eq!(none.kind(), std::io::ErrorKind::AddrInUse);
    });
}

/// The machine's own non-loopback IPv4 address: the source a route to a public address uses
/// (`connect` on UDP sends nothing).
fn interface_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(("192.0.2.1", 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

#[test]
fn the_server_listens_on_ipv4_loopback_only() {
    let e = env();
    let address = interface_address().expect("a non-loopback IPv4 interface on the test host");
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        // A refused or unanswered connect is unreachable (a host firewall may drop the SYN).
        let reach = |to: SocketAddr| TcpStream::connect_timeout(&to, CONNECT).is_ok();
        assert!(reach(SocketAddr::from((Ipv4Addr::LOCALHOST, port))));
        assert!(
            !reach(SocketAddr::from((address, port))),
            "reachable on {address}:{port}, not only on 127.0.0.1"
        );
        assert!(
            !reach(SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))),
            "reachable on [::1]:{port}"
        );
    });
}

fn inbox_item(e: &Env, id: &str) -> memry_core::api::inbox_records::InboxItemRecord {
    let open = e.session.current().unwrap();
    let inbox = open.vault.inbox(e.store.clone()).unwrap();
    inbox
        .get(id.to_owned())
        .unwrap()
        .expect("the captured item")
}

#[test]
fn a_capture_lands_in_the_inbox_and_a_repeat_url_enriches_it() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        let first = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&article("  https://example.com/post  "))
            .send(port)
            .await;
        assert_eq!(first.status, 200, "{:?}", first.body);
        assert_eq!(first.body["filedTo"], Value::Null);
        let id = first.body["itemId"].as_str().unwrap().to_owned();
        let item = inbox_item(&e, &id);
        assert_eq!(item.source_url.as_deref(), Some("https://example.com/post"));
        assert_eq!(item.capture_source.as_deref(), Some("browser-extension"));
        assert_eq!(item.tags, vec!["clippings".to_owned()]);

        let again = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&article("https://example.com/post"))
            .send(port)
            .await;
        assert_eq!(again.body["itemId"].as_str(), Some(id.as_str()));
        let mut forced = article("https://example.com/post");
        forced["force"] = json!(true);
        let forced = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&forced)
            .send(port)
            .await;
        assert_eq!(forced.status, 200);
        assert_ne!(forced.body["itemId"].as_str(), Some(id.as_str()));
    });
}

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

#[test]
fn screenshot_and_pdf_captures_store_their_files_in_the_vault() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        let mut pdf = article("https://example.com/paper.pdf");
        pdf["mode"] = json!("pdf");
        pdf["pdfDataUrl"] = json!("data:application/pdf;base64,JVBERi0xLjQK");
        pdf["pdfFilename"] = json!("Paper (final).pdf");
        let resp = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&pdf)
            .send(port)
            .await;
        assert_eq!(resp.status, 200, "{:?}", resp.body);
        let item = inbox_item(&e, resp.body["itemId"].as_str().unwrap());
        let path = item.attachment_path.expect("the stored pdf");
        assert!(path.ends_with("-Paper_final_.pdf"), "{path}");
        assert_eq!(std::fs::read(e.vault.join(&path)).unwrap(), b"%PDF-1.4\n");

        let mut shot = article("https://example.com/shot");
        shot["mode"] = json!("screenshot");
        shot["screenshotDataUrl"] = json!(format!("data:image/png;base64,{PNG}"));
        let resp = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&shot)
            .send(port)
            .await;
        assert_eq!(resp.status, 200, "{:?}", resp.body);
        let id = resp.body["itemId"].as_str().unwrap();
        let stored: Vec<_> = std::fs::read_dir(e.vault.join("attachments/inbox").join(id))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(stored.len(), 1, "{stored:?}");
        assert!(stored[0].ends_with("-screenshot.png"), "{stored:?}");
    });
}

#[test]
fn a_capture_that_fails_the_schema_is_422_and_stores_nothing() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        let with = |key: &str, value: Value| {
            let mut body = article("https://example.com/x");
            body[key] = value;
            body.to_string()
        };
        let without = |key: &str| {
            let mut body = article("https://example.com/x");
            body.as_object_mut().unwrap().remove(key);
            body.to_string()
        };
        for body in [
            "not json".to_owned(),
            "null".to_owned(),
            "[]".to_owned(),
            without("url"),
            without("properties"),
            with("url", json!("not a url")),
            with("mode", json!("video")),
            with("extractionStatus", json!("done")),
            with("heroImage", Value::Null),
            with("tags", json!("clippings")),
            with("tags", json!([1])),
            with("force", json!("yes")),
            with("folder", json!("")),
            with("folder", json!("x".repeat(1025))),
            with("vaultId", json!("x".repeat(129))),
            with("pdfFilename", json!("x".repeat(256))),
            "[".repeat(100_000),
        ] {
            let resp = req("POST", "/capture")
                .authed(CHROME, &token)
                .body(body.clone())
                .send(port)
                .await;
            assert_eq!(resp.refused(), (422, "invalid-capture"), "{:.80}", body);
        }
        let open = e.session.current().unwrap();
        let inbox = open.vault.inbox(e.store.clone()).unwrap();
        assert!(inbox.list(true).unwrap().is_empty());
    });
}

#[test]
fn folders_name_the_vault_by_hash_and_route_only_to_a_listed_folder() {
    let e = env();
    for dir in ["Reading", "archive", "Projects/Deep", "Zeta"] {
        std::fs::create_dir_all(e.vault.join(dir)).unwrap();
    }
    let filer = Arc::new(Filer::default());
    runtime().block_on(async {
        let server = capture::start_in(e.deps(Some(filer.clone())), 0, 1)
            .await
            .unwrap();
        let port = server.port();
        let token = e.paired(CHROME);
        let resp = req("POST", "/folders")
            .authed(CHROME, &token)
            .send(port)
            .await;
        assert_eq!(resp.status, 200);
        let path = e.vault.to_string_lossy().into_owned();
        let vault_id = hex::encode(Sha256::digest(path.as_bytes()))[..32].to_owned();
        assert_eq!(folders::vault_id(&path), vault_id);
        assert_eq!(
            resp.body,
            json!({
                "vaultId": vault_id,
                "vaultName": "Clippings Vault",
                "folders": ["archive", "Projects", "Projects/Deep", "Reading", "Zeta"],
            })
        );

        let routed = |folder: &str, id: &str| {
            let mut body = article(&format!("https://example.com/{folder}/{id}"));
            body["folder"] = json!(folder);
            body["vaultId"] = json!(id);
            req("POST", "/capture").authed(CHROME, &token).json(&body)
        };
        let filed = routed("Reading", &vault_id).send(port).await;
        assert_eq!(filed.body["filedTo"], "Reading");
        let item_id = filed.body["itemId"].as_str().unwrap().to_owned();
        assert_eq!(
            *filer.0.lock().unwrap(),
            vec![(item_id.clone(), "Reading".to_owned())]
        );
        inbox_item(&e, &item_id);
        for (folder, id) in [
            ("Reading", "0".repeat(32)),
            ("Missing", vault_id.clone()),
            ("reading", vault_id.clone()),
        ] {
            let kept = routed(folder, &id).send(port).await;
            assert_eq!(kept.status, 200);
            assert_eq!(kept.body["filedTo"], Value::Null, "{folder} {id}");
            inbox_item(&e, kept.body["itemId"].as_str().unwrap());
        }
        assert_eq!(filer.0.lock().unwrap().len(), 1);
    });
}

#[test]
fn without_a_filer_a_folder_capture_stays_in_the_inbox() {
    let e = env();
    std::fs::create_dir_all(e.vault.join("Reading")).unwrap();
    runtime().block_on(async {
        let server = e.start().await;
        let token = e.paired(CHROME);
        let mut body = article("https://example.com/kept");
        body["folder"] = json!("Reading");
        body["vaultId"] = json!(folders::vault_id(&e.vault.to_string_lossy()));
        let resp = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&body)
            .send(server.port())
            .await;
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body["filedTo"], Value::Null);
        let item = inbox_item(&e, resp.body["itemId"].as_str().unwrap());
        assert_eq!(item.filed_to, None);
    });
}

#[test]
fn raw_bytes_with_no_body_and_no_length_are_answered() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let raw = format!("GET /ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        let resp = send_raw(port, raw.as_bytes()).await;
        assert_eq!(resp.status, 200);
    });
}

fn deep(depth: usize) -> String {
    format!("{}{}", "[".repeat(depth), "]".repeat(depth))
}

#[test]
fn a_deep_capture_body_fails_closed_on_a_small_stack() {
    let parsed = on_small_stack(|| {
        serde_json::from_str::<Value>(&deep(200_000))
            .ok()
            .and_then(|value| schema::parse(&value))
    });
    assert_eq!(parsed, None);
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn the_schema_never_panics_on_any_json(text in "[\\[\\]{}\":,a-z0-9 .\\-]{0,200}") {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            let _ = schema::parse(&value);
        }
    }

    #[test]
    fn a_mutated_capture_parses_or_is_refused(key in "[a-zA-Z]{1,18}", value in any::<i64>()) {
        let mut body = article("https://example.com/p");
        body[key.as_str()] = json!(value);
        let _ = schema::parse(&body);
    }

    #[test]
    fn a_data_url_decodes_to_at_most_its_payload(text in "\\PC{0,300}") {
        let input = format!("data:image/png;base64,{text}");
        if let Some((_, bytes)) = ingest::parse_data_url(&input) {
            prop_assert!(bytes.len() <= text.len() * 3 / 4 + 2);
        }
    }

    #[test]
    fn the_host_check_takes_any_header(host in "\\PC{0,80}", port in any::<u16>()) {
        let allowed = auth::host_allowed(Some(&host), port);
        let expected = host == format!("127.0.0.1:{port}")
            || host.to_ascii_lowercase() == format!("localhost:{port}");
        prop_assert_eq!(allowed, expected);
    }
}
