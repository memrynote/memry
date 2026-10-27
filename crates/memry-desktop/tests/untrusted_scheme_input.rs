//! Guards of the parsers that read untrusted input in Step 10: the paths in `memry-file://` and
//! `memry-html://` URLs (peer input, from a synced note), the `Range` header, the loopback
//! request path and `Host`, and the navigation target. For each: depth on a 2 MiB thread,
//! complexity as a count of steps (never wall-clock), an input size bound, and properties under
//! proptest (CI fixes the seed with `PROPTEST_RNG_SEED`).

use std::cell::Cell;
use std::thread;

use memry_desktop::shell::external::is_allowed_external_url;
use memry_desktop::shell::file_serve::{ServePlan, plan};
use memry_desktop::shell::frame_nav::{Navigation, decide};
use memry_desktop::shell::local_scheme::{
    LocalScheme, MAX_URL_LEN, find_heal_candidate, locate, normalize_absolute, remap_cross_device,
    resolve_local_scheme_path,
};
use memry_desktop::shell::loopback_route::{Route, encode_media_target, route};
use proptest::prelude::*;

/// The stack the main thread of an embedded webview app may be left with.
const SMALL_STACK: usize = 2 * 1024 * 1024;
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn on_small_stack<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    thread::Builder::new()
        .stack_size(SMALL_STACK)
        .spawn(work)
        .unwrap()
        .join()
        .expect("the parser overflowed a 2 MiB stack or panicked")
}

// ---- depth ---------------------------------------------------------------------------------

#[test]
fn normalizing_a_path_a_million_segments_deep_does_not_recurse() {
    on_small_stack(|| {
        let deep = "a/".repeat(1_000_000);
        let up = "../".repeat(1_000_000);
        for windows in [false, true] {
            let posix = normalize_absolute(&format!("/{deep}"), windows);
            let climbed = normalize_absolute(&format!("/{deep}{up}x"), windows);
            if windows {
                assert_eq!(posix, None, "no drive: refused");
            } else {
                assert!(posix.is_some());
                assert_eq!(climbed.as_deref(), Some("/x"));
            }
        }
        assert_eq!(
            normalize_absolute(&format!("C:/{deep}{up}x"), true).as_deref(),
            Some("C:\\x")
        );
    });
}

#[test]
fn a_url_at_the_size_bound_with_the_deepest_path_resolves_on_a_small_stack() {
    on_small_stack(|| {
        let segments = "a/".repeat(MAX_URL_LEN / 2 - 40);
        let url = format!("memry-file://local/{segments}");
        assert!(url.len() <= MAX_URL_LEN);
        assert!(resolve_local_scheme_path(&url, LocalScheme::File, false).is_some());
        let encoded = format!(
            "memry-file://local/{}",
            "%2e%2e/".repeat(MAX_URL_LEN / 7 - 10)
        );
        assert_eq!(
            resolve_local_scheme_path(&encoded, LocalScheme::File, false).as_deref(),
            Some("/")
        );
    });
}

#[test]
fn the_other_parsers_survive_deep_input_on_a_small_stack() {
    on_small_stack(|| {
        let deep = "a/".repeat(500_000);
        assert!(remap_cross_device(&format!("/x/attachments/{deep}")).is_some());
        assert_eq!(
            remap_cross_device(&format!("/x/attachments/{deep}../y")),
            None
        );
        assert_eq!(
            locate(&format!("/v/{deep}"), &["/v".to_owned()], false)
                .unwrap()
                .root,
            0
        );
        let nested = format!("https://example.com/{}", "(".repeat(1_000_000));
        assert_eq!(
            decide(&nested, None, &[]),
            Navigation::Deny,
            "over the size bound"
        );
        assert!(!is_allowed_external_url(&nested));
        let path = format!("/m/{TOKEN}/{}", "A".repeat(1_000_000));
        assert_eq!(route(Some("127.0.0.1:1"), &path, 1, TOKEN), Route::NotFound);
        let header = format!("bytes={}", "0-1,".repeat(500_000));
        assert_eq!(plan(Some(&header), 10), ServePlan::Full);
    });
}

// ---- complexity: steps, not time -------------------------------------------------------------

#[test]
fn healing_reads_each_entry_of_the_folder_once() {
    for count in [10usize, 1_000, 50_000] {
        let names: Vec<String> = (0..count).map(|i| format!("{i:06x}-file{i}.png")).collect();
        let reads = Cell::new(0usize);
        let counted = names.iter().map(|name| {
            reads.set(reads.get() + 1);
            name.as_str()
        });
        let _ = find_heal_candidate(counted, "abc123-photo.png");
        assert_eq!(reads.get(), count, "one read per entry, at {count} entries");
    }
}

#[test]
fn a_hostile_name_set_cannot_make_healing_superlinear() {
    // Every name shares the expected prefix: all match, the scan stops at the second.
    let names: Vec<String> = (0..100_000).map(|i| format!("abc123-{i}.png")).collect();
    let reads = Cell::new(0usize);
    let counted = names.iter().map(|name| {
        reads.set(reads.get() + 1);
        name.as_str()
    });
    assert_eq!(find_heal_candidate(counted, "abc123-photo.png"), None);
    assert!(
        reads.get() <= 2,
        "stops at the second match, read {}",
        reads.get()
    );
}

#[test]
fn a_range_header_costs_the_same_however_many_ranges_it_lists() {
    // Only the first range is read; the rest is never scanned past the size bound.
    let one = plan(Some("bytes=0-9"), 100);
    let many = plan(Some(&format!("bytes=0-9{}", ",1-2".repeat(50))), 100);
    assert_eq!(one, many);
}

// ---- size bounds ------------------------------------------------------------------------------

#[test]
fn every_parser_refuses_input_over_its_bound_without_reading_it() {
    let url = format!("memry-file://local/{}", "a".repeat(MAX_URL_LEN));
    assert_eq!(
        resolve_local_scheme_path(&url, LocalScheme::File, false),
        None
    );
    assert_eq!(
        decide(
            &format!("https://e.com/{}", "a".repeat(MAX_URL_LEN)),
            None,
            &[]
        ),
        Navigation::Deny
    );
    assert!(!is_allowed_external_url(&format!(
        "https://e.com/{}",
        "a".repeat(MAX_URL_LEN)
    )));
    assert_eq!(
        plan(Some(&format!("bytes=0-{}", "9".repeat(1000))), 100),
        ServePlan::Full
    );
    let target = encode_media_target(&format!("memry-file://local/{}", "a".repeat(MAX_URL_LEN)));
    assert_eq!(
        route(
            Some("127.0.0.1:1"),
            &format!("/m/{TOKEN}/{target}"),
            1,
            TOKEN
        ),
        Route::NotFound
    );
}

// ---- properties -------------------------------------------------------------------------------

fn segments() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            Just("..".to_owned()),
            Just(".".to_owned()),
            Just("%2e%2e".to_owned()),
            Just("%2F".to_owned()),
            Just("attachments".to_owned()),
            Just("..%5C..".to_owned()),
            "[a-zA-Z0-9 _.%-]{0,12}",
            "\\PC{0,6}",
        ],
        0..24,
    )
    .prop_map(|parts| parts.join("/"))
}

fn config() -> ProptestConfig {
    ProptestConfig {
        // `PROPTEST_CASES` raises the count for the nightly run; CI fixes `PROPTEST_RNG_SEED`.
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|cases| cases.parse().ok())
            .unwrap_or(3000),
        ..ProptestConfig::default()
    }
}

proptest! {
    #![proptest_config(config())]

    /// A resolved path is absolute, shorter than its source, and holds no `.` or `..` segment:
    /// whatever a note's URL says, the path never climbs above the filesystem root.
    #[test]
    fn a_resolved_path_is_normalized_and_never_longer_than_the_input(path in segments(), windows in any::<bool>()) {
        let url = format!("memry-file://local/{}{path}", if windows { "C:/" } else { "" });
        if let Some(resolved) = resolve_local_scheme_path(&url, LocalScheme::File, windows) {
            let sep = if windows { '\\' } else { '/' };
            let rooted = if windows { resolved.as_bytes()[1] == b':' } else { resolved.starts_with('/') };
            prop_assert!(rooted);
            prop_assert!(!resolved.contains('\0'));
            prop_assert!(resolved.split(sep).all(|s| s != "." && s != ".."), "{resolved}");
            prop_assert!(resolved.len() <= url.len() + 3);
        }
    }

    /// `locate` returns a relative path that cannot name anything above its root.
    #[test]
    fn a_located_path_never_climbs_out_of_its_root(path in segments()) {
        let roots = vec!["/v".to_owned(), "/d".to_owned()];
        if let Some(normalized) = normalize_absolute(&format!("/v/{path}"), false)
            && let Some(found) = locate(&normalized, &roots, false)
        {
            prop_assert!(found.rel.split('/').all(|s| s != ".."), "{}", found.rel);
            prop_assert!(!found.rel.starts_with('/'));
        }
    }

    /// A remapped path is always `attachments/` plus plain segments.
    #[test]
    fn a_remapped_path_stays_inside_attachments(path in segments()) {
        if let Some(rel) = remap_cross_device(&format!("/x/attachments/{path}")) {
            prop_assert!(rel.starts_with("attachments/"));
            prop_assert!(rel.split('/').all(|s| s != ".." && s != "." && !s.is_empty()));
        }
    }

    /// A planned range lies inside the file, for any header text and any size.
    #[test]
    fn a_planned_range_lies_inside_the_file(header in "\\PC{0,80}", size in any::<u64>()) {
        match plan(Some(&header), size) {
            ServePlan::Partial { start, end } => prop_assert!(start <= end && end < size),
            ServePlan::Full | ServePlan::Unsatisfiable => {}
        }
    }

    #[test]
    fn a_range_of_numbers_is_clamped_to_the_file(a in any::<u64>(), b in any::<u64>(), size in 1u64..1_000_000) {
        for header in [format!("bytes={a}-{b}"), format!("bytes={a}-"), format!("bytes=-{b}")] {
            if let ServePlan::Partial { start, end } = plan(Some(&header), size) {
                prop_assert!(start <= end && end < size, "{header} {size}");
            }
        }
    }

    /// Only the one host and token answer, and a media route holds a `memry-file` URL.
    #[test]
    fn a_route_needs_the_exact_host_and_token(host in "\\PC{0,24}", path in "\\PC{0,60}", port in any::<u16>()) {
        let result = route(Some(&host), &path, port, TOKEN);
        if host != format!("127.0.0.1:{port}") {
            prop_assert_eq!(result, Route::BadHost);
        } else if let Route::Media(url) = result {
            prop_assert!(url.starts_with("memry-file://local/"));
            prop_assert!(path.contains(TOKEN));
        }
    }

    /// A navigation the guard does not allow in the window can only be sent to the OS as a web
    /// or mail link, or as a `memry-file` file: never a loopback, script or data URL.
    #[test]
    fn a_navigation_is_denied_unless_it_is_the_app_a_link_or_a_file(url in "\\PC{0,60}") {
        let origins = vec!["tauri://localhost".to_owned()];
        match decide(&url, None, &origins) {
            Navigation::OpenExternal => prop_assert!(is_allowed_external_url(&url)),
            Navigation::OpenFile => prop_assert!(url.to_ascii_lowercase().contains("memry-file")),
            Navigation::Allow | Navigation::Deny => {}
        }
    }

    /// A `%` that is not followed by two hex digits is refused, never kept as a literal.
    #[test]
    fn a_broken_percent_escape_is_refused(prefix in "[a-z]{0,8}", tail in "[g-z%]{0,2}") {
        let url = format!("memry-file://local/{prefix}%{tail}");
        let bad = tail.len() < 2 || !tail.bytes().take(2).all(|b| b.is_ascii_hexdigit());
        if bad {
            prop_assert_eq!(resolve_local_scheme_path(&url, LocalScheme::File, false), None);
        }
    }

    /// A token that is not the launch token never reaches a route.
    #[test]
    fn a_wrong_token_never_routes(given in "[0-9a-f]{0,70}", rest in "[A-Za-z0-9_-]{0,40}") {
        prop_assume!(given != TOKEN);
        let host = Some("127.0.0.1:9");
        for path in [format!("/m/{given}/{rest}"), format!("/e/{given}/youtube/dQw4w9WgXcQ")] {
            prop_assert_eq!(route(host, &path, 9, TOKEN), Route::NotFound);
        }
    }
}
