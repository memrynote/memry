//! Remote and local assets of an imported HTML page through the real client and importer: a
//! redirect to a private address is never followed, and a cancel lands before the next asset.

use std::fs;
use std::io::ErrorKind;
use std::net::TcpListener;
use std::sync::Arc;

use memry_desktop::import::html::{HtmlImporter, MAX_ASSET_BYTES};
use memry_desktop::import::remote::{HttpRemoteAssets, RemoteAssets, RemoteError};
use memry_desktop::import::{ImportContext, ImportInput, Importer};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::import_support::{RecordingSink, Timeline};
use crate::importer_untrusted::{CancelOnSave, ops};
use crate::unsplash_server::{Reply, serve};

/// The redirect policy is the only guard for an address literal: names go through the
/// public-only resolver, `https://127.0.0.1` does not. A listener stands at the target, so a
/// followed redirect shows up as a connection to it.
#[test]
fn a_redirect_to_a_private_address_is_not_followed() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let trap = TcpListener::bind("127.0.0.1:0").unwrap();
    trap.set_nonblocking(true).unwrap();
    let target = format!(
        "https://127.0.0.1:{}/a.png",
        trap.local_addr().unwrap().port()
    );
    let harness = runtime.block_on(serve(move |seen| {
        if seen.target == "/ok.png" {
            Reply::image("image/png", b"png")
        } else {
            Reply::status(302).with_header("location", &target)
        }
    }));
    let remote = HttpRemoteAssets::with_builder(harness.builder());
    let _context = runtime.enter();
    let fetch = |path: &str| {
        let url = Url::parse(&format!("https://other.example{path}")).unwrap();
        remote.fetch(&url, MAX_ASSET_BYTES)
    };

    assert_eq!(fetch("/ok.png"), Ok(b"png".to_vec()));
    assert_eq!(
        fetch("/moved.png"),
        Err(RemoteError::Unreachable("fetch failed".to_owned()))
    );
    assert_eq!(harness.seen().len(), 2);
    assert!(
        matches!(trap.accept(), Err(e) if e.kind() == ErrorKind::WouldBlock),
        "the redirect to 127.0.0.1 was followed"
    );
}

/// `if (ctx.isCancelled()) break` before each asset: the note is written with the assets saved
/// so far and the rest of its refs as written.
#[test]
fn a_cancel_lands_before_the_next_asset_of_a_page() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("one.png"), b"one").unwrap();
    fs::write(dir.path().join("two.png"), b"two").unwrap();
    let page = dir.path().join("p.html");
    fs::write(&page, r#"<img src="one.png"><img src="two.png">"#).unwrap();
    let input = ImportInput {
        source_paths: vec![page.to_string_lossy().into_owned()],
        options: None,
    };
    let (timeline, cancel) = (Timeline::default(), CancellationToken::new());
    let sink = CancelOnSave {
        inner: RecordingSink::new(Arc::clone(&timeline)),
        cancel: cancel.clone(),
    };
    let mut ctx = ImportContext::new("cancel", cancel, Box::new(|_| {}));

    HtmlImporter::default()
        .run(&input, &mut ctx, &sink)
        .unwrap();

    let calls = timeline.lock().unwrap().clone();
    assert_eq!(ops(&calls, "saveAttachment"), 1, "{calls:?}");
    let created: Vec<&Value> = calls.iter().filter(|c| c["op"] == "createNote").collect();
    assert_eq!(created.len(), 1, "{calls:?}");
    assert_eq!(
        created[0]["content"],
        "![](attachments/note-1/one.png)\n\n![](two.png)"
    );
}
