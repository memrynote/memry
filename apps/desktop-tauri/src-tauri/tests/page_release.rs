//! What a page holds goes when it starts a new document or its window closes (#3539, carry
//! item 3 of VERIFY-4449): `release_page_resources`, which both hooks of the page-watch plugin
//! call, ends that page's large-file leases, attachment uploads and AI provider calls, and
//! leaves another page's alone. The plugin's hooks are not driven: `RunEvent` is
//! non-exhaustive and `PageLoadPayload` has no public constructor.

#[allow(
    dead_code,
    reason = "the release reaches the services directly, never through the IPC"
)]
mod support;

use std::fs;
use std::sync::Arc;
use std::time::Instant;

use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProviderRequest, AiProxy, HttpMethod, Owner, ProxyError};
use memry_desktop::ai::settings::InlineAiSettings;
use memry_desktop::attachments::{AttachmentError, Uploads};
use memry_desktop::large_file::{
    EventSink, LargeFileOpenResult, LargeFileReadLinesInput, LargeFiles,
};
use memry_tauri::guards::process_gone::release_page_resources;
use support::{Mocked, WAIT};
use tauri::Manager;

/// The stored key: a test value, never a real one.
const KEY: &str = "test-key";

/// A lease of `label` on the note's file, once its lines can be read.
fn lease(files: &Arc<LargeFiles>, path: &std::path::Path, label: &str) -> String {
    let sink: EventSink = Arc::new(|_| {});
    let opened = files
        .open_file("n", label, fs::File::open(path).unwrap(), sink)
        .unwrap();
    let id = match opened {
        LargeFileOpenResult::Indexing { session_id, .. }
        | LargeFileOpenResult::Ready { session_id, .. } => session_id,
        other => panic!("not open: {other:?}"),
    };
    let deadline = Instant::now() + WAIT;
    while !readable(files, &id) {
        assert!(Instant::now() < deadline, "the lease never became readable");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    id
}

fn readable(files: &LargeFiles, id: &str) -> bool {
    let input = LargeFileReadLinesInput {
        session_id: id.to_owned(),
        start_line: 0,
        count: 1,
    };
    files.read_lines(&input).unwrap().is_some()
}

/// Opens a request of `owner` to a closed local port: refused as cancelled when its page went,
/// else sent and unreachable.
fn ai_outcome(proxy: &Arc<AiProxy>, owner: &Owner, id: &str) -> ProxyError {
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let settings = InlineAiSettings {
        enabled: true,
        provider: AiProvider::Custom,
        model: "m".to_owned(),
        api_key: KEY.to_owned(),
        base_url: format!("http://127.0.0.1:{port}/v1"),
    };
    let request = AiProviderRequest {
        request_id: id.to_owned(),
        provider: AiProvider::Custom,
        method: HttpMethod::Post,
        path: "/chat/completions".to_owned(),
        headers: Vec::new(),
        body: None,
    };
    let sink = Box::new(|_| true);
    tauri::async_runtime::block_on(proxy.open(&settings, request, owner, sink))
        .err()
        .expect("no provider listens there")
}

#[test]
fn a_page_that_goes_lets_go_of_its_leases_uploads_and_ai_calls() {
    let mocked = Mocked::open(
        &[("Note.md", "# Note\n\nline\n")],
        tauri_specta::Builder::new(),
    );
    let app = mocked.webview.app_handle().clone();
    let open = mocked.session().current().unwrap();
    let note = open
        .vault
        .note_files()
        .by_path("Note.md")
        .unwrap()
        .expect("a row for Note.md")
        .note_id;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let files = LargeFiles::new();
    let uploads = Uploads::new();
    let proxy = AiProxy::new(memry_desktop::http::builder().no_proxy());
    app.manage(files.clone());
    app.manage(uploads.clone());
    app.manage(proxy.clone());

    let path = mocked.vault.join("Note.md");
    let (main_lease, other_lease) = (lease(&files, &path, "main"), lease(&files, &path, "note-1"));
    let main_upload = uploads.begin(&open, "main", &note, "a.pdf", 10).unwrap();
    let other_upload = uploads.begin(&open, "note-1", &note, "b.pdf", 10).unwrap();
    // Taken when each command began, before its settings read.
    let (main_owner, other_owner) = (proxy.owner("main"), proxy.owner("note-1"));

    release_page_resources(&app, "main");

    assert!(!readable(&files, &main_lease));
    assert!(readable(&files, &other_lease));
    assert!(matches!(
        uploads.write_chunk(&open, &main_upload, 0, b"x"),
        Err(AttachmentError::UploadGone)
    ));
    assert!(matches!(
        uploads.write_chunk(&open, &other_upload, 0, b"x"),
        Ok(None)
    ));
    assert_eq!(
        ai_outcome(&proxy, &main_owner, "main-call"),
        ProxyError::Cancelled
    );
    assert!(matches!(
        ai_outcome(&proxy, &other_owner, "other-call"),
        ProxyError::Unreachable { .. }
    ));
}
