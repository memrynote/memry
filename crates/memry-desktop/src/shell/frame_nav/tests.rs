use super::*;

fn origins() -> Vec<String> {
    vec![
        "tauri://localhost".to_owned(),
        "https://tauri.localhost".to_owned(),
    ]
}

const LOOPBACK: &str = "http://127.0.0.1:41234";

fn guard(origins: &[String]) -> Guard<'_> {
    Guard {
        app_origins: origins,
        loopback_origin: Some(LOOPBACK),
    }
}

fn main(url: &str) -> Navigation {
    decide_main(url, &guard(&origins()))
}

fn frame(url: &str) -> bool {
    frame_may_load(url, &guard(&origins()))
}

#[test]
fn the_app_origin_stays_in_the_main_frame() {
    assert_eq!(main("tauri://localhost/index.html"), Navigation::Allow);
    assert_eq!(
        main("tauri://localhost/index.html#/notes/1"),
        Navigation::Allow
    );
    assert_eq!(main("https://tauri.localhost/"), Navigation::Allow);
    assert_eq!(
        decide_main(
            "http://localhost:5173/x",
            &guard(&["http://localhost:5173".to_owned()])
        ),
        Navigation::Allow
    );
    // The dev server is not an app origin in a packaged build.
    assert_eq!(main("http://localhost:5173/"), Navigation::Deny);
}

#[test]
fn web_and_mail_links_go_to_the_os() {
    assert_eq!(main("https://example.com/a"), Navigation::OpenExternal);
    assert_eq!(main("http://192.168.1.20:8080/x"), Navigation::OpenExternal);
    assert_eq!(main("mailto:hi@memrynote.com"), Navigation::OpenExternal);
}

#[test]
fn loopback_targets_never_reach_the_os_browser() {
    for url in [
        "http://localhost:5173/",
        "http://127.0.0.1:9999/m/token/abc",
        "http://127.0.0.1:41234/e/token/youtube/x",
        "http://127.1/",
        "http://[::1]:80/",
        "http://0.0.0.0/",
        "https://a.localhost/",
    ] {
        assert_eq!(main(url), Navigation::Deny, "{url}");
    }
}

#[test]
fn script_data_file_and_unknown_schemes_are_refused_in_the_main_frame() {
    for url in [
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "blob:https://x/abc",
        "about:blank",
        "file:///etc/passwd",
        "memry://open?x=1",
        "smb://host/share",
        "",
        "not a url",
    ] {
        assert_eq!(main(url), Navigation::Deny, "{url}");
    }
}

#[test]
fn a_memry_file_navigation_opens_the_file_and_an_embed_is_refused() {
    assert_eq!(
        main("memry-file://local/Users/kaan/vault/a.pdf"),
        Navigation::OpenFile
    );
    assert_eq!(
        main("https://memry-file.localhost/local/C:/v/a.pdf"),
        Navigation::OpenFile
    );
    assert_eq!(
        main("memry-html://local/Users/kaan/vault/attachments/n/a.html"),
        Navigation::Deny
    );
    assert_eq!(
        main("https://memry-html.localhost/local/v/attachments/n/a.html"),
        Navigation::Deny
    );
}

#[test]
fn an_oversize_url_is_refused() {
    let long = format!("https://example.com/{}", "a".repeat(20_000));
    assert_eq!(main(&long), Navigation::Deny);
    assert!(!frame(&long));
    assert!(!is_app_page(
        &format!("tauri://localhost/{}", "a".repeat(20_000)),
        &origins()
    ));
}

#[test]
fn an_embed_the_loopback_page_and_its_player_load_in_a_frame() {
    for url in [
        "memry-html://local/Users/kaan/vault/attachments/n/a.html",
        "https://memry-html.localhost/local/v/attachments/n/a.html",
        "http://127.0.0.1:41234/e/token/youtube/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0",
        "about:srcdoc",
        "tauri://localhost/index.html",
    ] {
        assert!(frame(url), "{url}");
    }
}

/// An HTML attachment's `<iframe src="https://...">` or `meta refresh` is a frame's own load.
/// Sending it to the OS browser would open the browser with no click, on a loop.
#[test]
fn a_frame_loads_a_web_page_in_place() {
    for url in ["https://example.com/", "http://example.com/a?b=c"] {
        assert!(frame(url), "{url}");
    }
}

#[test]
fn a_frame_never_loads_scripts_local_files_or_other_loopback_routes() {
    for url in [
        // Another port, another host, and the media route are not the embed page.
        "http://127.0.0.1:9/e/token/youtube/x",
        "http://127.0.0.1:41234/m/token/abc",
        "http://127.0.0.1:41234/",
        "http://localhost:5173/",
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "blob:https://x/abc",
        "file:///etc/passwd",
        "memry://open?x=1",
        // A frame's mail link would reach the OS without a click; the main frame decides its own.
        "mailto:hi@memrynote.com",
        // WebKit commits `about:blank` with no response to refuse, so in the main frame it would
        // replace the app. Only `about:srcdoc`, which a top frame cannot navigate to, loads.
        "about:blank",
        "about:blank#x",
        "about:srcdoc?x",
        "not a url",
    ] {
        assert!(!frame(url), "{url}");
    }
}

#[test]
fn only_an_app_origin_is_the_app() {
    let origins = origins();
    for url in [
        "tauri://localhost/index.html#/notes",
        "https://tauri.localhost/index.html",
    ] {
        assert!(is_app_page(url, &origins), "{url}");
    }
    for url in [
        "https://example.com/a",
        "http://127.0.0.1:41234/m/token/notes/a.md",
        "https://tauri.localhost.evil.test/",
        "http://tauri.localhost/",
        "tauri://localhost.evil/",
        "about:blank",
        "data:text/html,x",
        "memry-file://localhost/x",
        "memry-html://local/v/attachments/n/a.html",
        "https://memry-html.localhost/local/v/a.html",
        "not a url",
    ] {
        assert!(!is_app_page(url, &origins), "{url}");
    }
}

/// Whatever the main frame may show is what it shows the app on.
#[test]
fn the_main_frame_is_allowed_exactly_the_app_pages() {
    let origins = origins();
    for url in [
        "tauri://localhost/",
        "https://tauri.localhost/x",
        "https://example.com/",
        "memry-html://local/v/a.html",
        "memry-file://local/v/a.pdf",
        "about:blank",
        "http://127.0.0.1:41234/e/t/youtube/x",
    ] {
        assert_eq!(
            main(url) == Navigation::Allow,
            is_app_page(url, &origins),
            "{url}"
        );
    }
}
