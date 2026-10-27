use super::*;

fn origins() -> Vec<String> {
    vec![
        "tauri://localhost".to_owned(),
        "https://tauri.localhost".to_owned(),
    ]
}

fn go(url: &str) -> Navigation {
    decide(url, Some("tauri://localhost/index.html"), &origins())
}

#[test]
fn the_app_origin_and_hash_changes_stay_in_the_window() {
    assert_eq!(go("tauri://localhost/index.html"), Navigation::Allow);
    assert_eq!(
        go("tauri://localhost/index.html#/notes/1"),
        Navigation::Allow
    );
    assert_eq!(go("https://tauri.localhost/"), Navigation::Allow);
    assert_eq!(
        decide(
            "http://localhost:5173/",
            Some("http://localhost:5173/x"),
            &["http://localhost:5173".to_owned()]
        ),
        Navigation::Allow
    );
    // The dev server is not an app origin in a packaged build.
    assert_eq!(go("http://localhost:5173/"), Navigation::Deny);
}

#[test]
fn web_and_mail_links_go_to_the_os() {
    assert_eq!(go("https://example.com/a"), Navigation::OpenExternal);
    assert_eq!(go("http://example.com"), Navigation::OpenExternal);
    assert_eq!(go("mailto:hi@memrynote.com"), Navigation::OpenExternal);
}

#[test]
fn loopback_targets_never_reach_the_os_browser() {
    for url in [
        "http://localhost:5173/",
        "http://127.0.0.1:9999/m/token/abc",
        "http://127.1/",
        "http://[::1]:80/",
        "http://0.0.0.0/",
        "https://a.localhost/",
    ] {
        assert_eq!(go(url), Navigation::Deny, "{url}");
    }
}

#[test]
fn script_data_file_and_unknown_schemes_are_refused() {
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
        assert_eq!(go(url), Navigation::Deny, "{url}");
    }
}

#[test]
fn a_memry_file_navigation_opens_the_file_and_an_embed_is_refused() {
    assert_eq!(
        go("memry-file://local/Users/kaan/vault/a.pdf"),
        Navigation::OpenFile
    );
    assert_eq!(
        go("https://memry-file.localhost/local/C:/v/a.pdf"),
        Navigation::OpenFile
    );
    assert_eq!(
        go("memry-html://local/Users/kaan/vault/attachments/n/a.html"),
        Navigation::Deny
    );
    assert_eq!(
        go("https://memry-html.localhost/local/v/attachments/n/a.html"),
        Navigation::Deny
    );
}

#[test]
fn an_oversize_url_is_refused() {
    let long = format!("https://example.com/{}", "a".repeat(20_000));
    assert_eq!(go(&long), Navigation::Deny);
}

#[test]
fn without_a_current_page_only_origins_and_links_decide() {
    assert_eq!(
        decide("tauri://localhost/", None, &origins()),
        Navigation::Allow
    );
    assert_eq!(
        decide("https://example.com", None, &origins()),
        Navigation::OpenExternal
    );
}
