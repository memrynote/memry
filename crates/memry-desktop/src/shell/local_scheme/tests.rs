use super::*;

fn file(url: &str, windows: bool) -> Option<String> {
    resolve_local_scheme_path(url, LocalScheme::File, windows)
}

#[test]
fn resolves_posix_urls_and_decodes_percent_escapes() {
    assert_eq!(
        file("memry-file://local/Users/kaan/vault/file.png", false).as_deref(),
        Some("/Users/kaan/vault/file.png")
    );
    assert_eq!(
        file("memry-file://local/Users/kaan/vault/my%20file.pdf", false).as_deref(),
        Some("/Users/kaan/vault/my file.pdf")
    );
    assert_eq!(
        file("memry-file://local/Users/kaan/%C3%A7%C4%B1.png", false).as_deref(),
        Some("/Users/kaan/çı.png")
    );
}

#[test]
fn resolves_windows_urls_to_backslash_paths() {
    assert_eq!(
        file(
            "memry-file://local/C:/Users/Leib.000/Koofr/0-WAITING/doc.pdf",
            true
        )
        .as_deref(),
        Some("C:\\Users\\Leib.000\\Koofr\\0-WAITING\\doc.pdf")
    );
    assert_eq!(
        file("memry-file://local//server/share/a/b.png", true).as_deref(),
        Some("\\\\server\\share\\a\\b.png")
    );
    // No drive and no UNC root: Electron resolved this against the working directory.
    assert_eq!(file("memry-file://local/Users/kaan/a.png", true), None);
}

#[test]
fn normalizes_traversal_without_leaving_the_root() {
    assert_eq!(
        file("memry-file://local/Users/kaan/vault/../secret.txt", false).as_deref(),
        Some("/Users/kaan/secret.txt")
    );
    assert_eq!(
        file("memry-file://local/../../etc/passwd", false).as_deref(),
        Some("/etc/passwd")
    );
    assert_eq!(
        file("memry-file://local/a/%2e%2e/%2E%2E/b", false).as_deref(),
        Some("/b")
    );
    assert_eq!(
        file("memry-file://local/C:/a/../../../b.txt", true).as_deref(),
        Some("C:\\b.txt")
    );
    // An encoded separator is decoded before normalization, as `decodeURIComponent` did.
    assert_eq!(
        file("memry-file://local/a/..%2F..%2Fetc/passwd", false).as_deref(),
        Some("/etc/passwd")
    );
}

#[test]
fn reads_the_webview_form_of_the_url() {
    assert_eq!(
        file(
            "https://memry-file.localhost/local/Users/kaan/a%20b.png",
            false
        )
        .as_deref(),
        Some("/Users/kaan/a b.png")
    );
    assert_eq!(
        file("http://memry-file.localhost/local/C:/v/a.png", true).as_deref(),
        Some("C:\\v\\a.png")
    );
    assert_eq!(
        file("https://memry-file.localhost/other/a.png", false),
        None
    );
    assert_eq!(
        file("https://memry-html.localhost/local/a/b.html", false),
        None
    );
    assert_eq!(
        resolve_local_scheme_path(
            "https://memry-html.localhost/local/v/attachments/n/a.html",
            LocalScheme::Html,
            false
        )
        .as_deref(),
        Some("/v/attachments/n/a.html")
    );
}

#[test]
fn refuses_other_urls_malformed_escapes_nul_and_oversize() {
    assert_eq!(file("https://example.com/local/a.png", false), None);
    assert_eq!(file("not a url", false), None);
    assert_eq!(file("memry-file://local/%zz", false), None);
    assert_eq!(file("memry-file://local/%ff%fe", false), None);
    assert_eq!(file("memry-file://local/a%00b", false), None);
    assert_eq!(file("memry-html://local/a/b.html", false), None);
    let long = format!("memry-file://local/{}", "a/".repeat(MAX_URL_LEN));
    assert_eq!(file(&long, false), None);
}

#[test]
fn a_path_inside_a_root_is_located_and_a_prefix_sibling_is_not() {
    let roots = vec![
        "/Users/kaan/vault".to_owned(),
        "/Users/kaan/data".to_owned(),
    ];
    assert_eq!(
        locate("/Users/kaan/vault/doc.pdf", &roots, false),
        Some(Located {
            root: 0,
            rel: "doc.pdf".into()
        })
    );
    assert_eq!(
        locate("/Users/kaan/vault", &roots, false),
        Some(Located {
            root: 0,
            rel: String::new()
        })
    );
    assert_eq!(
        locate("/Users/kaan/data/a/b.png", &roots, false),
        Some(Located {
            root: 1,
            rel: "a/b.png".into()
        })
    );
    assert_eq!(locate("/Users/kaan/vault2/doc.pdf", &roots, false), None);
    assert_eq!(locate("/Users/kaan/vaul", &roots, false), None);
    assert_eq!(locate("/etc/passwd", &roots, false), None);
}

#[test]
fn windows_roots_match_backslash_paths_and_yield_forward_slash_relatives() {
    let roots = vec!["C:\\Users\\Leib.000\\Koofr".to_owned()];
    assert_eq!(
        locate(
            "C:\\Users\\Leib.000\\Koofr\\0-WAITING\\100 Healthy Habits.pdf",
            &roots,
            true
        ),
        Some(Located {
            root: 0,
            rel: "0-WAITING/100 Healthy Habits.pdf".into()
        })
    );
    assert_eq!(
        locate("C:\\Users\\Leib.000\\Koofr2\\a.pdf", &roots, true),
        None
    );
    let drive = vec!["C:\\".to_owned()];
    assert_eq!(
        locate("C:\\a\\b.txt", &drive, true),
        Some(Located {
            root: 0,
            rel: "a/b.txt".into()
        })
    );
    let slash = vec!["/".to_owned()];
    assert_eq!(
        locate("/a/b", &slash, false),
        Some(Located {
            root: 0,
            rel: "a/b".into()
        })
    );
}

#[test]
fn remaps_a_foreign_absolute_path_onto_the_vault_attachments() {
    assert_eq!(
        remap_cross_device("/Users/other/Notes/attachments/n1/abc123-photo.png").as_deref(),
        Some("attachments/n1/abc123-photo.png")
    );
    assert_eq!(
        remap_cross_device("C:\\Users\\x\\vault\\attachments\\n1\\a.png").as_deref(),
        Some("attachments/n1/a.png")
    );
    // The last marker wins: a vault folder itself named attachments does not confuse it.
    assert_eq!(
        remap_cross_device("/a/attachments/b/attachments/n/f.png").as_deref(),
        Some("attachments/n/f.png")
    );
    assert_eq!(remap_cross_device("/Users/other/notes/readme.md"), None);
    assert_eq!(remap_cross_device("/v/attachments/"), None);
    assert_eq!(remap_cross_device("/v/attachments/n/../../secret"), None);
    assert_eq!(remap_cross_device("/v/attachments/./n/a"), None);
}

#[test]
fn heals_a_renamed_attachment_by_prefix_or_suffix_when_exactly_one_matches() {
    let entries = &["abc123-renamed.png", "zzzzzz-other.png", ".hidden"];
    assert_eq!(
        find_heal_candidate(entries.iter().copied(), "abc123-photo.png"),
        Some("abc123-renamed.png")
    );

    let stripped = &["photo.png", "zzzzzz-other.png"];
    assert_eq!(
        find_heal_candidate(stripped.iter().copied(), "abc123-photo.png"),
        Some("photo.png")
    );

    let new_prefix = &["qqqqqq-photo.png"];
    assert_eq!(
        find_heal_candidate(new_prefix.iter().copied(), "abc123-photo.png"),
        Some("qqqqqq-photo.png")
    );

    // The expected file with no prefix matches by name, ignoring a stored prefix.
    let bare = &["abc123-photo.png"];
    assert_eq!(
        find_heal_candidate(bare.iter().copied(), "photo.png"),
        Some("abc123-photo.png")
    );
}

#[test]
fn heals_nothing_when_zero_or_several_match_or_the_file_is_there() {
    let two = &["abc123-a.png", "abc123-b.png"];
    assert_eq!(
        find_heal_candidate(two.iter().copied(), "abc123-photo.png"),
        None
    );
    assert_eq!(
        find_heal_candidate(["zzzzzz-x.png"].iter().copied(), "abc123-photo.png"),
        None
    );
    assert_eq!(
        find_heal_candidate(["abc123-photo.png"].iter().copied(), "abc123-photo.png"),
        None
    );
    assert_eq!(
        find_heal_candidate([".abc123-x.png"].iter().copied(), "abc123-photo.png"),
        None
    );
    // A name too short or with a capital letter has no stored prefix.
    assert_eq!(
        find_heal_candidate(["ABC123-x.png"].iter().copied(), "ABC123-photo.png"),
        None
    );
    assert_eq!(find_heal_candidate(std::iter::empty(), ""), None);
}

#[test]
fn only_the_exact_attachment_shape_is_healed() {
    assert_eq!(
        attachment_parts("attachments/n1/a.png"),
        Some(("n1", "a.png"))
    );
    assert_eq!(attachment_parts("attachments/a.png"), None);
    assert_eq!(attachment_parts("attachments/n1/sub/a.png"), None);
    assert_eq!(attachment_parts("notes/n1/a.png"), None);
    assert_eq!(attachment_parts("attachments//a.png"), None);
}
