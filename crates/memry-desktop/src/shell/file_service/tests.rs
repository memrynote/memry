use std::fs;
use std::path::Path;

use tempfile::TempDir;

use super::*;

const APP: &str = "tauri://localhost";

fn req(range: Option<&str>) -> FileRequest<'_> {
    FileRequest {
        range,
        ..FileRequest::default()
    }
}

struct Fixture {
    _dir: TempDir,
    vault: PathBuf,
    data: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    let vault = base.join("vault");
    let data = base.join("data");
    fs::create_dir_all(vault.join("attachments/n1")).unwrap();
    fs::create_dir_all(&data).unwrap();
    Fixture {
        _dir: dir,
        vault,
        data,
    }
}

impl Fixture {
    fn roots(&self) -> Roots {
        Roots {
            vault: Some(self.vault.clone()),
            app_data: self.data.clone(),
            app_origins: vec![APP.to_owned(), "https://tauri.localhost".to_owned()],
            reply_origin: APP.to_owned(),
        }
    }

    fn url(path: &Path) -> String {
        let encoded: Vec<String> = path
            .to_string_lossy()
            .split('/')
            .map(|s| s.replace(' ', "%20"))
            .collect();
        format!("memry-file://local{}", encoded.join("/"))
    }

    fn serve(&self, path: &Path, range: Option<&str>) -> Served {
        serve_file(
            &Self::url(path),
            &req(range),
            &self.roots(),
            false,
            Caps::UNBOUNDED,
        )
    }
}

fn bytes_of(served: Served) -> Vec<u8> {
    match served.body {
        Body::Bytes(bytes) => bytes,
        Body::File {
            mut file,
            start,
            len,
        } => read_range(&mut file, start, len).unwrap(),
        Body::Empty => Vec::new(),
    }
}

fn header<'a>(served: &'a Served, name: &str) -> Option<&'a str> {
    served
        .headers
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, v)| v.as_str())
}

#[test]
fn serves_a_vault_file_whole_and_by_range() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-clip.mp4");
    fs::write(&file, b"0123456789").unwrap();

    let whole = fx.serve(&file, None);
    assert_eq!(whole.status, 200);
    assert_eq!(header(&whole, "Content-Type"), Some("video/mp4"));
    assert_eq!(header(&whole, "Content-Length"), Some("10"));
    assert_eq!(bytes_of(whole), b"0123456789");

    let part = fx.serve(&file, Some("bytes=2-4"));
    assert_eq!(part.status, 206);
    assert_eq!(header(&part, "Content-Range"), Some("bytes 2-4/10"));
    assert_eq!(bytes_of(part), b"234");

    let suffix = fx.serve(&file, Some("bytes=-3"));
    assert_eq!(bytes_of(suffix), b"789");

    let past = fx.serve(&file, Some("bytes=10-"));
    assert_eq!(past.status, 416);
    assert_eq!(header(&past, "Content-Range"), Some("bytes */10"));
}

#[test]
fn decodes_a_percent_encoded_name_and_serves_the_app_data_dir() {
    let fx = fixture();
    let file = fx.data.join("my file.pdf");
    fs::write(&file, b"%PDF").unwrap();
    let served = fx.serve(&file, None);
    assert_eq!(served.status, 200);
    assert_eq!(header(&served, "Content-Type"), Some("application/pdf"));
}

#[test]
fn refuses_a_path_outside_every_root() {
    let fx = fixture();
    let outside = fx.vault.parent().unwrap().join("secret.txt");
    fs::write(&outside, b"secret").unwrap();
    assert_eq!(fx.serve(&outside, None).status, 403);
    assert_eq!(fx.serve(&fx.vault.join("../secret.txt"), None).status, 403);
    // A sibling that shares the vault's name as a prefix.
    let sibling = fx.vault.parent().unwrap().join("vault2");
    fs::create_dir_all(&sibling).unwrap();
    fs::write(sibling.join("a.txt"), b"x").unwrap();
    assert_eq!(fx.serve(&sibling.join("a.txt"), None).status, 403);
}

#[cfg(unix)]
#[test]
fn refuses_a_link_that_leaves_the_root_and_a_hard_link() {
    let fx = fixture();
    let outside = fx.vault.parent().unwrap().join("secret.txt");
    fs::write(&outside, b"secret").unwrap();
    std::os::unix::fs::symlink(&outside, fx.vault.join("attachments/n1/link.txt")).unwrap();
    assert_eq!(
        fx.serve(&fx.vault.join("attachments/n1/link.txt"), None)
            .status,
        403
    );
    std::os::unix::fs::symlink(fx.vault.parent().unwrap(), fx.vault.join("attachments/up"))
        .unwrap();
    assert_eq!(
        fx.serve(&fx.vault.join("attachments/up/secret.txt"), None)
            .status,
        403
    );
    fs::hard_link(&outside, fx.vault.join("attachments/n1/hard.txt")).unwrap();
    assert_eq!(
        fx.serve(&fx.vault.join("attachments/n1/hard.txt"), None)
            .status,
        403
    );
}

#[test]
fn serves_a_path_written_on_another_device_from_this_vault() {
    let fx = fixture();
    let local = fx.vault.join("attachments/n1/abc123-photo.png");
    fs::write(&local, b"png").unwrap();
    let foreign = "memry-file://local/Users/other/Notes/attachments/n1/abc123-photo.png";
    let served = serve_file(foreign, &req(None), &fx.roots(), false, Caps::UNBOUNDED);
    assert_eq!(served.status, 200);
    assert_eq!(bytes_of(served), b"png");
    // The file is not here: the remap answers 403, not a read outside the vault.
    let absent = "memry-file://local/Users/other/Notes/attachments/n1/none.png";
    assert_eq!(
        serve_file(absent, &req(None), &fx.roots(), false, Caps::UNBOUNDED).status,
        403
    );
    let climb = "memry-file://local/Users/other/attachments/../../etc/passwd";
    assert_eq!(
        serve_file(climb, &req(None), &fx.roots(), false, Caps::UNBOUNDED).status,
        403
    );
}

#[test]
fn heals_an_attachment_renamed_on_disk_before_the_blank_image_fallback() {
    let fx = fixture();
    fs::write(fx.vault.join("attachments/n1/abc123-renamed.png"), b"png").unwrap();
    let missing = fx.vault.join("attachments/n1/abc123-photo.png");
    let served = fx.serve(&missing, None);
    assert_eq!(served.status, 200);
    assert_eq!(bytes_of(served), b"png");
    // Two candidates: nothing is healed, and a missing image is the blank PNG.
    fs::write(fx.vault.join("attachments/n1/abc123-second.png"), b"two").unwrap();
    let blank = fx.serve(&missing, None);
    assert_eq!(blank.status, 200);
    assert_eq!(header(&blank, "Content-Type"), Some("image/png"));
    assert_eq!(&bytes_of(blank)[..4], b"\x89PNG");
}

#[test]
fn a_missing_file_is_404_except_an_image_which_is_blank() {
    let fx = fixture();
    assert_eq!(
        fx.serve(&fx.vault.join("attachments/n1/none.pdf"), None)
            .status,
        404
    );
    assert_eq!(
        fx.serve(&fx.vault.join("attachments/n1/none.webp"), None)
            .status,
        200
    );
    assert_eq!(fx.serve(&fx.vault.join("attachments/n1"), None).status, 404);
}

#[test]
fn an_attached_html_file_is_text_from_memry_file() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-page.html");
    fs::write(&file, b"<script>alert(1)</script>").unwrap();
    let served = fx.serve(&file, None);
    assert_eq!(
        header(&served, "Content-Type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(header(&served, "X-Content-Type-Options"), Some("nosniff"));
}

#[test]
fn a_range_longer_than_the_chunk_is_a_shorter_partial_answer() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-big.mp4");
    fs::write(&file, vec![7u8; 100]).unwrap();
    let url = Fixture::url(&file);
    let caps = Caps {
        range_chunk: 40,
        whole_file: u64::MAX,
    };
    let open = serve_file(&url, &req(Some("bytes=50-")), &fx.roots(), false, caps);
    assert_eq!(header(&open, "Content-Range"), Some("bytes 50-89/100"));
    let small = serve_file(&url, &req(Some("bytes=10-19")), &fx.roots(), false, caps);
    assert_eq!(header(&small, "Content-Range"), Some("bytes 10-19/100"));
}

#[test]
fn a_whole_file_request_is_never_answered_with_a_truncated_206() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-big.png");
    fs::write(&file, vec![7u8; 100]).unwrap();
    let url = Fixture::url(&file);
    let small = Caps {
        range_chunk: 40,
        whole_file: 200,
    };
    let whole = serve_file(&url, &req(None), &fx.roots(), false, small);
    assert_eq!(whole.status, 200);
    assert_eq!(bytes_of(whole).len(), 100);
    // Too big to answer in one body: a refusal the client can see, not a short 206.
    let tight = Caps {
        range_chunk: 40,
        whole_file: 50,
    };
    let refused = serve_file(&url, &req(None), &fx.roots(), false, tight);
    assert_eq!(refused.status, 413);
    assert!(header(&refused, "Content-Range").is_none());
}

#[test]
fn only_an_app_origin_may_read_a_file() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-clip.txt");
    fs::write(&file, b"0123").unwrap();
    let url = Fixture::url(&file);
    let ask = |origin: Option<&str>, dest: Option<&str>| {
        serve_file(
            &url,
            &FileRequest {
                range: None,
                origin,
                fetch_dest: dest,
            },
            &fx.roots(),
            false,
            Caps::UNBOUNDED,
        )
    };
    let app = ask(Some(APP), Some("empty"));
    assert_eq!(app.status, 200);
    assert_eq!(header(&app, "Access-Control-Allow-Origin"), Some(APP));
    assert_eq!(header(&app, "Vary"), Some("Origin"));
    // A sandboxed embed sends `Origin: null`; another page sends its own.
    for origin in [
        "null",
        "https://evil.example",
        "https://memry-html.localhost",
    ] {
        let refused = ask(Some(origin), Some("empty"));
        assert_eq!(refused.status, 403, "{origin}");
        assert!(header(&refused, "Access-Control-Allow-Origin").is_none());
    }
    // No `Origin` (WebView2 shows the handler none): the answer allows the app's page origin only,
    // so the browser's own check refuses a `null`-origin embed that reads it.
    let plain = ask(None, Some("empty"));
    assert_eq!(plain.status, 200);
    assert_eq!(header(&plain, "Access-Control-Allow-Origin"), Some(APP));
    // A file is data to the app, never a script, a style sheet, a frame or a document.
    for dest in ["script", "style", "iframe", "document", "worker", "object"] {
        assert_eq!(ask(None, Some(dest)).status, 403, "{dest}");
    }
}

#[test]
fn every_file_is_sandboxed_when_the_engine_renders_it_as_a_document() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-pic.svg");
    fs::write(&file, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
    let served = fx.serve(&file, None);
    assert_eq!(
        header(&served, "Content-Security-Policy"),
        Some("sandbox; default-src 'none'")
    );
    assert_eq!(header(&served, "X-Content-Type-Options"), Some("nosniff"));
    let permissions = header(&served, "Permissions-Policy").unwrap_or_default();
    assert!(permissions.contains("microphone=()") && permissions.contains("camera=()"));
}

#[test]
fn urls_that_are_not_memry_file_are_404() {
    let fx = fixture();
    for url in [
        "https://example.com/a.png",
        "memry-file://local/%zz",
        "",
        "memry-html://local/a.html",
    ] {
        assert_eq!(
            serve_file(url, &req(None), &fx.roots(), false, Caps::UNBOUNDED).status,
            404,
            "{url}"
        );
    }
}

fn html_url(path: &Path) -> String {
    Fixture::url(path).replacen("memry-file", "memry-html", 1)
}

#[test]
fn memry_html_serves_an_attachment_with_the_sandbox_policy() {
    let fx = fixture();
    let file = fx.vault.join("attachments/n1/abc123-page.html");
    fs::write(&file, "<html><body>hi</body></html>").unwrap();
    let served = serve_html(&html_url(&file), true, Some(&fx.vault), false);
    assert_eq!(served.status, 200);
    assert_eq!(
        header(&served, "Content-Security-Policy"),
        Some(HTML_EMBED_CSP)
    );
    assert_eq!(header(&served, "Referrer-Policy"), Some("no-referrer"));
    assert_eq!(header(&served, "X-Content-Type-Options"), Some("nosniff"));
    assert_eq!(header(&served, "Cache-Control"), Some("no-store"));
    assert_eq!(
        header(&served, "Content-Type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(bytes_of(served), b"<html><body>hi</body></html>");

    let latin = fx.vault.join("attachments/n1/abc123-latin.htm");
    fs::write(&latin, "<meta charset=windows-1254>").unwrap();
    let served = serve_html(&html_url(&latin), true, Some(&fx.vault), false);
    assert_eq!(header(&served, "Content-Type"), Some("text/html"));
}

#[test]
fn memry_html_refuses_everything_but_get_of_a_vault_html_attachment() {
    let fx = fixture();
    let page = fx.vault.join("attachments/n1/abc123-page.html");
    fs::write(&page, "x").unwrap();
    assert_eq!(
        serve_html(&html_url(&page), false, Some(&fx.vault), false).status,
        405
    );
    assert_eq!(serve_html(&html_url(&page), true, None, false).status, 404);

    let text = fx.vault.join("attachments/n1/abc123-note.txt");
    fs::write(&text, "x").unwrap();
    assert_eq!(
        serve_html(&html_url(&text), true, Some(&fx.vault), false).status,
        404
    );

    let outside = fx.vault.join("notes.html");
    fs::write(&outside, "x").unwrap();
    assert_eq!(
        serve_html(&html_url(&outside), true, Some(&fx.vault), false).status,
        404
    );
    let data = fx.data.join("a.html");
    fs::write(&data, "x").unwrap();
    assert_eq!(
        serve_html(&html_url(&data), true, Some(&fx.vault), false).status,
        404
    );
    let climb = format!(
        "{}/../../x.html",
        html_url(&page).trim_end_matches("/abc123-page.html")
    );
    assert_eq!(serve_html(&climb, true, Some(&fx.vault), false).status, 404);
    // memry-file is not memry-html.
    assert_eq!(
        serve_html(&Fixture::url(&page), true, Some(&fx.vault), false).status,
        404
    );
}

#[test]
fn memry_html_remaps_and_heals_like_memry_file() {
    let fx = fixture();
    fs::write(fx.vault.join("attachments/n1/abc123-page.html"), "x").unwrap();
    let foreign = "memry-html://local/Users/other/Notes/attachments/n1/abc123-page.html";
    assert_eq!(
        serve_html(foreign, true, Some(&fx.vault), false).status,
        200
    );
    // Renamed on disk after the note was written: the new prefix keeps the name.
    fs::rename(
        fx.vault.join("attachments/n1/abc123-page.html"),
        fx.vault.join("attachments/n1/qqqqqq-page.html"),
    )
    .unwrap();
    let stale = fx.vault.join("attachments/n1/abc123-page.html");
    assert_eq!(
        serve_html(&html_url(&stale), true, Some(&fx.vault), false).status,
        200
    );
    fs::rename(
        fx.vault.join("attachments/n1/qqqqqq-page.html"),
        fx.vault.join("attachments/n1/zzzzzz-other.html"),
    )
    .unwrap();
    assert_eq!(
        serve_html(&html_url(&stale), true, Some(&fx.vault), false).status,
        404
    );
}

#[cfg(unix)]
#[test]
fn memry_html_refuses_a_link_out_of_the_vault() {
    let fx = fixture();
    let outside = fx.vault.parent().unwrap().join("evil.html");
    fs::write(&outside, "x").unwrap();
    let link = fx.vault.join("attachments/n1/abc123-evil.html");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert_eq!(
        serve_html(&html_url(&link), true, Some(&fx.vault), false).status,
        404
    );
}

#[test]
fn an_oversize_html_file_is_refused() {
    let fx = fixture();
    let big = fx.vault.join("attachments/n1/abc123-big.html");
    let file = fs::File::create(&big).unwrap();
    file.set_len(MAX_HTML_BYTES + 1).unwrap();
    assert_eq!(
        serve_html(&html_url(&big), true, Some(&fx.vault), false).status,
        404
    );
}

#[test]
fn a_read_that_fails_answers_404_without_the_planned_length_or_range() {
    let fx = fixture();
    // A directory opens as a file on Unix and fails on read; on Windows the open itself fails.
    let Ok(dir) = fs::File::open(&fx.vault) else {
        return;
    };
    let planned = Served {
        status: 206,
        headers: vec![
            ("Content-Length", "10".to_owned()),
            ("Content-Range", "bytes 0-9/100".to_owned()),
        ],
        body: Body::File {
            file: dir,
            start: 0,
            len: 10,
        },
        failure: None,
    };
    let settled = planned.settle();
    assert_eq!(settled.status, 404);
    assert!(settled.headers.is_empty());
    assert!(settled.bytes.is_empty());
    assert!(settled.failure.is_some());
}
