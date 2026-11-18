//! Pairing the extension with the capture server over a real loopback socket (Step 27, #3544):
//! the claim window, the consent prompt, revoke, the keychain failing closed, a pairing that
//! Electron wrote and the import carried over, and the extension's own request shapes
//! (`apps/extension/src/lib/capture-client.ts`) from probe to revoke.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::registry::AppConfig;
use memry_desktop::services::capture::pairing::{ACCOUNT, ALLOWLIST_KEY, Pairing, SERVICE};
use serde_json::{Value, json};

use crate::capture_support::{
    CHROME, FIREFOX, Keychain, OTHER_CHROME, Req, Resp, article, busy_port, env, env_with_config,
    req, runtime,
};

/// `claimToken`: the capture header, and the `Origin` the browser adds.
fn claim(origin: &str) -> Req {
    req("POST", "/pair/claim")
        .header("Origin", origin)
        .header("X-Memry-Capture", "1")
}

fn pair_request(origin: &str) -> Req {
    req("POST", "/pair/request")
        .header("Origin", origin)
        .header("X-Memry-Capture", "1")
}

#[test]
fn a_claim_needs_an_origin_and_an_open_window_and_closes_it() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let r = req("POST", "/pair/claim")
            .header("X-Memry-Capture", "1")
            .send(port)
            .await;
        assert_eq!(r.refused(), (400, "missing-origin"));
        let r = claim(CHROME).send(port).await;
        assert_eq!(r.refused(), (403, "pairing-window-closed"));
        assert_eq!(
            e.keychain.writes.load(Ordering::SeqCst),
            0,
            "no token minted"
        );

        // The `pair` deep link, after its confirm dialog: any extension origin may claim once.
        e.pairing.open_window();
        let r = claim("https://evil.example").send(port).await;
        assert_eq!(r.refused(), (403, "pairing-window-closed"));
        let r = claim(FIREFOX).send(port).await;
        assert_eq!(r.status, 200);
        let token = r.body["token"].as_str().unwrap().to_owned();
        assert_eq!(r.body, json!({ "token": token, "port": port }));
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(e.keychain.token().as_deref(), Some(token.as_str()));
        assert_eq!(e.config_json()[ALLOWLIST_KEY], json!([FIREFOX]));
        let r = claim(CHROME).send(port).await;
        assert_eq!(
            r.refused(),
            (403, "pairing-window-closed"),
            "one claim per window"
        );
    });
}

#[test]
fn a_claim_window_closes_when_its_time_is_up() {
    let e = env();
    e.pairing.open_window_for(None, Duration::ZERO);
    assert!(e.pairing.claim(CHROME).unwrap().is_none());
}

#[test]
fn a_window_opened_for_one_origin_admits_only_that_origin() {
    let e = env();
    e.pairing.finish_consent(CHROME, true);
    assert!(e.pairing.claim(OTHER_CHROME).unwrap().is_none());
    assert!(e.pairing.claim(CHROME).unwrap().is_some());
    e.pairing
        .open_window_for(Some(CHROME), Duration::from_secs(60));
    assert!(e.pairing.claim(FIREFOX).unwrap().is_none());
    assert!(!e.pairing.is_allowed(Some(OTHER_CHROME)));
    assert!(!e.pairing.is_allowed(Some(FIREFOX)));
}

#[test]
fn a_pair_request_is_checked_then_trusted_only_after_consent() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let r = req("POST", "/pair/request")
            .header("X-Memry-Capture", "1")
            .send(port)
            .await;
        assert_eq!(r.refused(), (400, "missing-origin"));
        let r = pair_request("https://evil.example").send(port).await;
        assert_eq!(r.refused(), (403, "origin-not-allowed"));
        let r = req("POST", "/pair/request")
            .header("Origin", CHROME)
            .send(port)
            .await;
        assert_eq!(r.refused(), (401, "missing-capture-header"));

        let r = pair_request(CHROME).send(port).await;
        assert_eq!(
            (r.status, r.body.clone()),
            (202, json!({ "status": "pending" }))
        );
        assert_eq!(e.prompt.shown(), CHROME);
        // The prompt is up: nothing is trusted yet, and a repeat asks no second prompt.
        let r = claim(CHROME).send(port).await;
        assert_eq!(r.refused(), (403, "pairing-window-closed"));
        let r = pair_request(CHROME).send(port).await;
        assert_eq!(r.status, 202);
        assert!(e.prompt.not_shown(), "one prompt per origin at a time");
        assert!(!e.pairing.is_allowed(Some(CHROME)));

        e.prompt.answer(true);
        let token = until_claimed(port, CHROME).await;
        assert_eq!(e.keychain.token().as_deref(), Some(token.as_str()));
        assert!(e.pairing.is_allowed(Some(CHROME)));
    });
}

/// Claims for `origin` until the answered prompt has opened its window.
async fn until_claimed(port: u16, origin: &str) -> String {
    for _ in 0..500 {
        let r = claim(origin).send(port).await;
        if r.status == 200 {
            return r.body["token"].as_str().unwrap().to_owned();
        }
        assert_eq!(r.refused(), (403, "pairing-window-closed"));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the window never opened for {origin}");
}

#[test]
fn a_denied_prompt_ends_the_extensions_poll_once() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        pair_request(CHROME).send(port).await;
        assert_eq!(e.prompt.shown(), CHROME);
        e.prompt.answer(false);
        let mut denied = None;
        for _ in 0..500 {
            let r = claim(CHROME).send(port).await;
            if r.refused().1 == "pair-denied" {
                denied = Some(r);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(denied.expect("pair-denied").status, 403);
        let r = claim(CHROME).send(port).await;
        assert_eq!(r.refused(), (403, "pairing-window-closed"), "reported once");
        assert!(!e.pairing.is_allowed(Some(CHROME)));
        assert_eq!(e.keychain.writes.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn an_already_paired_origin_reclaims_without_a_prompt() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        let r = pair_request(CHROME).send(port).await;
        assert_eq!(
            (r.status, r.body.clone()),
            (200, json!({ "status": "already-paired" }))
        );
        assert!(e.prompt.not_shown());
        let r = claim(OTHER_CHROME).send(port).await;
        assert_eq!(r.refused(), (403, "pairing-window-closed"));
        let r = claim(CHROME).send(port).await;
        assert_eq!(r.body["token"].as_str(), Some(token.as_str()));
    });
}

#[test]
fn revoke_unpairs_every_origin_and_forgets_the_token() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let token = e.paired(CHROME);
        e.paired(FIREFOX);
        let r = req("POST", "/pair/revoke")
            .authed(CHROME, &token)
            .send(port)
            .await;
        assert_eq!((r.status, r.body.clone()), (200, json!({ "ok": true })));
        assert_eq!(e.keychain.token(), None);
        assert_eq!(e.config_json()[ALLOWLIST_KEY], json!([]));
        for origin in [CHROME, FIREFOX] {
            let r = req("POST", "/capture")
                .authed(origin, &token)
                .json(&article("https://example.com/a"))
                .send(port)
                .await;
            assert_eq!(r.refused(), (401, "origin-not-allowed"));
        }
        let r = claim(CHROME).send(port).await;
        assert_eq!(r.refused(), (403, "pairing-window-closed"));
        let fresh = e.paired(CHROME);
        assert_ne!(fresh, token);
    });
}

#[test]
fn a_locked_keychain_fails_the_request_and_mints_nothing() {
    let e = env();
    // An allowlisted origin whose token is in a keychain the server cannot read yet.
    e.keychain.put(SERVICE, ACCOUNT, b"stored-token");
    e.config
        .update(|c| {
            c.insert(ALLOWLIST_KEY.to_owned(), json!([CHROME]));
            Ok::<_, memry_desktop::registry::ConfigError>(())
        })
        .unwrap();
    e.keychain.locked.store(true, Ordering::SeqCst);
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        for route in ["/capture", "/folders", "/tags", "/pair/revoke"] {
            let r = req("POST", route)
                .authed(CHROME, "stored-token")
                .json(&article("https://example.com/a"))
                .send(port)
                .await;
            assert_eq!(r.refused(), (500, "internal"), "{route}");
        }
        e.pairing.open_window();
        let r = claim(OTHER_CHROME).send(port).await;
        assert_eq!(r.refused(), (500, "internal"));
        assert_eq!(
            e.config_json()[ALLOWLIST_KEY],
            json!([CHROME]),
            "nobody added"
        );

        e.keychain.locked.store(false, Ordering::SeqCst);
        assert_eq!(
            e.keychain.writes.load(Ordering::SeqCst),
            0,
            "nothing minted"
        );
        assert_eq!(e.keychain.token().as_deref(), Some("stored-token"));
        let r = req("POST", "/capture")
            .authed(CHROME, "stored-token")
            .json(&article("https://example.com/a"))
            .send(port)
            .await;
        assert_eq!(r.status, 200, "the old pairing still works after unlock");
    });
}

#[test]
fn an_unreadable_stored_token_is_replaced() {
    for stored in [&[0xff, 0xfe][..], &b""[..]] {
        let e = env();
        e.keychain.put(SERVICE, ACCOUNT, stored);
        let token = e.pairing.token().unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(e.keychain.token().as_deref(), Some(token.as_str()));
    }
}

#[test]
fn the_token_account_is_electrons_unsuffixed_one() {
    // Electron keeps `pairing-token` without the `MEMRY_DEVICE` suffix
    // (`secret-storage-callsites.test.ts:377`), and Step 37 imports the name unchanged.
    let e = env();
    let keychain = Arc::new(Keychain::default());
    keychain.put(SERVICE, "pairing-token", b"electron-token");
    let pairing = Pairing::new(keychain.clone(), e.config.clone());
    assert_eq!(pairing.token().unwrap().as_str(), "electron-token");
    assert_eq!(keychain.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn one_origins_pair_request_leaves_another_origins_window_open() {
    let e = env();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        e.paired(CHROME);
        e.pairing.finish_consent(OTHER_CHROME, true);
        let r = pair_request(CHROME).send(port).await;
        assert_eq!(r.body, json!({ "status": "already-paired" }));
        let r = claim(OTHER_CHROME).send(port).await;
        assert_eq!(r.status, 200, "{:?}", r.body);
        let r = claim(CHROME).send(port).await;
        assert_eq!(r.status, 200, "{:?}", r.body);
        // The deep link's window is a slot of its own: an origin's window does not use it up.
        e.pairing.open_window();
        e.pairing
            .open_window_for(Some(OTHER_CHROME), Duration::from_secs(60));
        assert!(e.pairing.claim(OTHER_CHROME).unwrap().is_some());
        assert!(e.pairing.claim(FIREFOX).unwrap().is_some());
    });
}

/// `memry-config.json` as Electron's store leaves it after a pairing, unknown keys included.
const ELECTRON_CONFIG: &str = r#"{
  "theme": "dark",
  "captureAllowedOrigins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop"],
  "windowBounds": { "width": 1200, "height": 800 },
  "someFutureKey": { "nested": [1, "two", null] }
}"#;

#[test]
fn a_pairing_electron_wrote_works_without_pairing_again() {
    let e = env_with_config(Some(ELECTRON_CONFIG));
    // Step 37 moves Electron's `com.memry.capture`/`pairing-token` to this service unchanged
    // (`electron_import/secrets_import/tests/mod.rs:280`).
    let token = "9f".repeat(32);
    e.keychain.put(SERVICE, ACCOUNT, token.as_bytes());
    let before: Value = serde_json::from_str(ELECTRON_CONFIG).unwrap();
    runtime().block_on(async {
        let server = e.start().await;
        let port = server.port();
        let ping = req("GET", "/ping")
            .header("Origin", CHROME)
            .send(port)
            .await;
        assert_eq!(ping.body["paired"], true);
        let r = req("POST", "/capture")
            .authed(CHROME, &token)
            .json(&article("https://example.com/kept"))
            .send(port)
            .await;
        assert_eq!(r.status, 200, "{:?}", r.body);

        e.pairing.open_window();
        let r = claim(FIREFOX).send(port).await;
        assert_eq!(r.body["token"].as_str(), Some(token.as_str()));
    });
    assert_eq!(e.keychain.writes.load(Ordering::SeqCst), 0);
    let after = e.config_json();
    assert_eq!(after[ALLOWLIST_KEY], json!([CHROME, FIREFOX]));
    for key in ["theme", "windowBounds", "someFutureKey"] {
        assert_eq!(after[key], before[key], "{key} kept");
    }
    // A new app run reads the same pairing back.
    let reloaded = Pairing::new(
        e.keychain.clone(),
        Arc::new(AppConfig::load(e.config.path().to_owned())),
    );
    assert!(reloaded.is_allowed(Some(FIREFOX)));
}

/// What Chrome's `fetch` from the extension's service worker puts on the wire.
fn chrome(r: Req, origin: &str) -> Req {
    r.header("Connection", "keep-alive")
        .header("sec-ch-ua-platform", "\"macOS\"")
        .header("User-Agent", "Mozilla/5.0 (Macintosh) Chrome/131.0.0.0")
        .header("Accept", "*/*")
        .header("Origin", origin)
        .header("Sec-Fetch-Site", "none")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Dest", "empty")
        .header("Accept-Encoding", "gzip, deflate, br, zstd")
        .header("Accept-Language", "en-US,en;q=0.9")
}

/// `captureHeaders(token)` as the extension spells them.
fn capture_headers(r: Req, token: &str) -> Req {
    r.header("Content-Type", "application/json")
        .header("Authorization", &format!("Bearer {token}"))
        .header("X-Memry-Capture", "1")
}

async fn probe(ports: &[u16]) -> Option<(u16, Resp)> {
    for &port in ports {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            continue;
        }
        let r = req("GET", "/ping").send(port).await;
        if r.status == 200 && r.body["app"] == "memry" {
            return Some((port, r));
        }
    }
    None
}

#[test]
fn the_extension_pairs_lists_captures_and_revokes_as_it_ships() {
    let e = env();
    std::fs::create_dir_all(e.vault.join("Reading")).unwrap();
    runtime().block_on(async {
        // Another program's HTTP server on the first port of the range.
        let (busy, first) = busy_port().await;
        let other = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = busy.accept().await {
                // The whole request first: closing with it unread resets the connection.
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let not_memry =
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(not_memry).await;
            }
        });
        let server =
            memry_desktop::services::capture::start_in(e.deps(None), Default::default(), first, 8)
                .await
                .unwrap();
        let ports: Vec<u16> = (0..8).filter_map(|i| first.checked_add(i)).collect();
        // `probeServer`: the busy port answers nothing the extension accepts.
        let (port, ping) = probe(&ports).await.expect("a memry server");
        assert_eq!(port, server.port());
        assert_eq!(ping.body["paired"], false);
        assert_eq!(ping.body["capabilities"], json!(["folders"]));

        // `requestPair`, then `pollUntil(claimToken)`.
        let r = chrome(req("POST", "/pair/request"), CHROME)
            .header("X-Memry-Capture", "1")
            .send(port)
            .await;
        assert_eq!(r.status, 202);
        assert_eq!(e.prompt.shown(), CHROME);
        e.prompt.answer(true);
        let mut claimed = None;
        for _ in 0..500 {
            let r = chrome(req("POST", "/pair/claim"), CHROME)
                .header("X-Memry-Capture", "1")
                .send(port)
                .await;
            if r.status == 200 {
                claimed = r.body["token"].as_str().map(str::to_owned);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let token = claimed.expect("a claimed token");

        // `getFolders`, `getTags`, `postCapture` to a folder, `postRevoke`.
        let r = capture_headers(chrome(req("POST", "/folders"), CHROME), &token)
            .send(port)
            .await;
        assert_eq!(r.status, 200);
        assert_eq!(r.body["folders"], json!(["Reading"]));
        let vault_id = r.body["vaultId"].as_str().unwrap().to_owned();
        let r = capture_headers(chrome(req("POST", "/tags"), CHROME), &token)
            .send(port)
            .await;
        assert_eq!((r.status, r.body.clone()), (200, json!({ "tags": [] })));
        let mut body = article("https://example.com/article");
        body["folder"] = json!("Reading");
        body["vaultId"] = json!(vault_id);
        let r = capture_headers(chrome(req("POST", "/capture"), CHROME), &token)
            .json(&body)
            .send(port)
            .await;
        assert_eq!(r.status, 200, "{:?}", r.body);
        assert!(r.body["itemId"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(r.body["filedTo"], Value::Null, "no filer until stage 6");
        let r = capture_headers(chrome(req("POST", "/pair/revoke"), CHROME), &token)
            .send(port)
            .await;
        assert_eq!(r.status, 200);
        let r = req("GET", "/ping")
            .header("Origin", CHROME)
            .send(port)
            .await;
        assert_eq!(r.body["paired"], false);
        other.abort();
    });
}

#[test]
fn tags_list_the_vaults_tags_most_used_first() {
    use crate::index_support::{all_indexed, until, with_task};
    use crate::vault_env::{env as vault_env, indexed};
    use memry_desktop::vault::consumer::Applied;
    use tokio::sync::broadcast;

    let mut store = None;
    let mut v = vault_env(|s| {
        store = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    v.write("A.md", "---\ntags: [plan]\n---\nA\n");
    v.write("B.md", "---\ntags: [work, plan]\n---\nB\n");
    v.write("C.md", "---\ntags: [plan, work, solo]\n---\nC\n");
    v.open();
    v.facts_until(indexed);
    let open = v.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(4);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("every file measured", || all_indexed(&v));
    });

    let e = env();
    let deps = memry_desktop::services::capture::CaptureDeps {
        session: v.session.clone(),
        store: store.unwrap(),
        ..e.deps(None)
    };
    let token = e.paired(CHROME);
    runtime().block_on(async {
        let server = memry_desktop::services::capture::start_in(deps, Default::default(), 0, 1)
            .await
            .unwrap();
        let r = req("POST", "/tags")
            .authed(CHROME, &token)
            .send(server.port())
            .await;
        assert_eq!(r.status, 200);
        assert_eq!(r.body, json!({ "tags": ["plan", "work", "solo"] }));
    });
}
