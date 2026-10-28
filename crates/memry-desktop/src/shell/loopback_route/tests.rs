use super::*;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PORT: u16 = 41234;
const HOST: Option<&str> = Some("127.0.0.1:41234");

fn media_path(url: &str) -> String {
    format!("/m/{TOKEN}/{}", encode_media_target(url))
}

#[test]
fn a_media_route_carries_the_canonical_url() {
    let url = "memry-file://local/Users/kaan/vault/attachments/n/a%20b.mp4";
    assert_eq!(
        route(HOST, &media_path(url), PORT, TOKEN),
        Route::Media(url.to_owned())
    );
}

#[test]
fn a_youtube_route_carries_a_valid_video_id() {
    let path = format!("/e/{TOKEN}/youtube/dQw4w9WgXcQ");
    assert_eq!(
        route(HOST, &path, PORT, TOKEN),
        Route::YoutubeEmbed("dQw4w9WgXcQ".to_owned())
    );
    for bad in [
        "short",
        "dQw4w9WgXcQ1",
        "dQw4w9WgXc!",
        "dQw4w9Wg%2FcQ",
        "..%2F..%2F.%2F.",
    ] {
        let path = format!("/e/{TOKEN}/youtube/{bad}");
        assert_eq!(route(HOST, &path, PORT, TOKEN), Route::NotFound, "{bad}");
    }
}

#[test]
fn a_host_that_is_not_the_servers_address_is_refused() {
    let path = media_path("memry-file://local/a.mp4");
    for host in [
        None,
        Some("evil.example.com"),
        Some("127.0.0.1"),
        Some("127.0.0.1:1"),
        Some("localhost:41234"),
        Some("127.0.0.1:41234.evil.com"),
        Some("127.0.0.1:41234 "),
    ] {
        assert_eq!(route(host, &path, PORT, TOKEN), Route::BadHost, "{host:?}");
    }
}

#[test]
fn a_wrong_token_is_a_plain_not_found() {
    let path = format!(
        "/m/{}/{}",
        "f".repeat(64),
        encode_media_target("memry-file://local/a.mp4")
    );
    assert_eq!(route(HOST, &path, PORT, TOKEN), Route::NotFound);
    let short = format!("/m/{}/x", &TOKEN[..63]);
    assert_eq!(route(HOST, &short, PORT, TOKEN), Route::NotFound);
    assert_eq!(
        route(
            HOST,
            &format!("/m//{}", encode_media_target("memry-file://local/a")),
            PORT,
            TOKEN
        ),
        Route::NotFound
    );
}

#[test]
fn only_memry_file_urls_can_be_asked_for() {
    for url in [
        "file:///etc/passwd",
        "https://example.com/a.mp4",
        "memry-html://local/v/attachments/n/a.html",
        "memry-file://other/a.mp4",
        "http://127.0.0.1:41234/m/x/y",
    ] {
        assert_eq!(
            route(HOST, &media_path(url), PORT, TOKEN),
            Route::NotFound,
            "{url}"
        );
    }
}

#[test]
fn malformed_paths_are_not_found() {
    for path in [
        "",
        "/",
        "/m",
        &format!("/m/{TOKEN}"),
        &format!("/m/{TOKEN}/"),
        &format!("/m/{TOKEN}/!!!notbase64"),
        &format!(
            "/m/{TOKEN}/{}=",
            encode_media_target("memry-file://local/a.mp4")
        ),
        &format!(
            "/m/{TOKEN}/{}/extra",
            encode_media_target("memry-file://local/a.mp4")
        ),
        &format!("/x/{TOKEN}/youtube/dQw4w9WgXcQ"),
        &format!("/e/{TOKEN}/vimeo/dQw4w9WgXcQ"),
        &format!("/e/{TOKEN}/youtube/dQw4w9WgXcQ/more"),
        &format!("//m/{TOKEN}/abc"),
    ] {
        assert_eq!(route(HOST, path, PORT, TOKEN), Route::NotFound, "{path}");
    }
}

#[test]
fn a_path_or_target_longer_than_any_real_url_is_refused_unread() {
    let huge = format!("/m/{TOKEN}/{}", "A".repeat(MAX_PATH_LEN));
    assert_eq!(route(HOST, &huge, PORT, TOKEN), Route::NotFound);
    let url = format!("memry-file://local/{}", "a".repeat(MAX_URL_LEN));
    assert_eq!(route(HOST, &media_path(&url), PORT, TOKEN), Route::NotFound);
}

#[test]
fn the_embed_page_frames_only_youtube_nocookie_with_the_referrer_policy() {
    let html = youtube_embed_html("dQw4w9WgXcQ");
    assert!(html.contains(
        "src=\"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&amp;rel=0\""
    ));
    assert!(html.contains("referrerpolicy=\"strict-origin-when-cross-origin\""));
    assert!(html.contains("<meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">"));
    assert!(html.contains("allow=\"autoplay; encrypted-media; picture-in-picture\""));
    assert_eq!(html.matches("<iframe").count(), 1);
    assert!(
        EMBED_CSP.starts_with("default-src 'none'; frame-src https://www.youtube-nocookie.com")
    );
}

#[test]
fn tokens_compare_by_value_and_length() {
    assert!(same_token("abc", "abc"));
    assert!(!same_token("abc", "abd"));
    assert!(!same_token("abc", "abcd"));
    assert!(!same_token("", "a"));
    assert!(same_token("", ""));
}
