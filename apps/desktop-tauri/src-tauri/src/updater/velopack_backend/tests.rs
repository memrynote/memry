use std::io;

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::updater::severity::{NetworkKind, UpdateErrorKind};
use velopack::{NetworkError, VelopackAsset};

use super::*;

fn http(error: ureq::Error) -> velopack::Error {
    velopack::Error::Network(Box::new(NetworkError::Http(error)))
}

fn kind(error: velopack::Error) -> UpdateErrorKind {
    map_error(error).kind
}

#[test]
fn the_production_feed_is_compiled_in_unless_a_rehearsal_sets_one() {
    match REHEARSAL_FEED {
        None => {
            assert_eq!(FEED, Feed::Production);
            assert_eq!(FEED_URL, "https://github.com/memrynote/memry");
        }
        Some(url) => {
            assert_eq!(FEED, Feed::Rehearsal(url));
            assert_eq!(FEED_URL, url);
        }
    }
}

/// The proof jobs pass the workflow token so a shared CI runner's exhausted unauthenticated API
/// quota cannot fail the check; a production build reads a github.com feed too, and never sends
/// one.
#[test]
fn only_a_rehearsal_build_on_a_github_feed_reads_the_feed_token() {
    let mut env = LaunchEnv::default();
    env.set(FEED_TOKEN_VAR, "ghs_test");
    let rehearsal = Feed::Rehearsal("https://github.com/memrynote/memry-update-rehearsal");
    assert_eq!(rehearsal.token(&env).as_deref(), Some("ghs_test"));
    assert!(Feed::Production.url().starts_with("https://github.com/"));
    assert_eq!(Feed::Production.token(&env), None);
    assert_eq!(
        Feed::Rehearsal("https://feed.example/memry").token(&env),
        None
    );
    assert_eq!(Feed::Rehearsal("/tmp/feed").token(&env), None);
    env.set(FEED_TOKEN_VAR, "");
    assert_eq!(rehearsal.token(&env), None);
    assert_eq!(rehearsal.token(&LaunchEnv::default()), None);
}

#[test]
fn an_http_status_keeps_its_code() {
    assert_eq!(
        kind(http(ureq::Error::StatusCode(404))),
        UpdateErrorKind::Status(404)
    );
}

#[test]
fn transport_failures_map_to_their_network_kind() {
    use NetworkKind as N;
    let cases = [
        (http(ureq::Error::HostNotFound), N::HostNotFound),
        (http(ureq::Error::ConnectionFailed), N::ConnectionFailed),
        (
            http(ureq::Error::Io(io::ErrorKind::ConnectionReset.into())),
            N::Reset,
        ),
        (
            http(ureq::Error::Io(io::ErrorKind::BrokenPipe.into())),
            N::Reset,
        ),
        (
            http(ureq::Error::Io(io::ErrorKind::NetworkUnreachable.into())),
            N::Unreachable,
        ),
        (
            http(ureq::Error::Io(io::ErrorKind::ConnectionRefused.into())),
            N::Unreachable,
        ),
        (
            http(ureq::Error::Io(io::ErrorKind::TimedOut.into())),
            N::Timeout,
        ),
        (
            http(ureq::Error::Io(io::ErrorKind::PermissionDenied.into())),
            N::Other,
        ),
        (http(ureq::Error::Tls("bad certificate")), N::Other),
        (http(ureq::Error::TooManyRedirects), N::Other),
    ];
    for (error, expected) in cases {
        let message = error.to_string();
        assert_eq!(kind(error), UpdateErrorKind::Network(expected), "{message}");
    }
}

/// The resolver's failure reaches `ureq` as a plain `io::Error`: Windows gives `WSAHOST_NOT_FOUND`
/// (seen offline on the Windows VM), Unix `getaddrinfo`'s message.
#[test]
fn a_failed_name_lookup_is_host_not_found_on_every_os() {
    for error in [
        io::Error::from_raw_os_error(11001),
        io::Error::from_raw_os_error(11002),
        io::Error::other(
            "failed to lookup address information: nodename nor servname provided, or not known",
        ),
    ] {
        let message = error.to_string();
        assert_eq!(
            kind(http(ureq::Error::Io(error))),
            UpdateErrorKind::Network(NetworkKind::HostNotFound),
            "{message}"
        );
    }
}

#[test]
fn a_dropped_download_body_is_a_network_failure_not_a_disk_one() {
    // ureq hands the body reader's failure back as an io::Error around its own error.
    let body = io::Error::other(ureq::Error::Io(io::ErrorKind::ConnectionReset.into()));
    assert_eq!(
        kind(velopack::Error::Io(body)),
        UpdateErrorKind::Network(NetworkKind::Reset)
    );
    let host = io::Error::other(ureq::Error::HostNotFound);
    assert_eq!(
        kind(velopack::Error::Io(host)),
        UpdateErrorKind::Network(NetworkKind::HostNotFound)
    );
}

#[test]
fn a_read_only_volume_is_recognized_by_kind_os_code_or_message() {
    let by_kind = io::Error::from(io::ErrorKind::ReadOnlyFilesystem);
    let by_code = io::Error::from_raw_os_error(EROFS);
    let by_message = io::Error::other("cannot write: Read-only file system");
    for error in [by_kind, by_code, by_message] {
        assert_eq!(
            kind(velopack::Error::Io(error)),
            UpdateErrorKind::ReadOnlyVolume
        );
    }
}

#[test]
fn every_other_failure_is_other_with_its_text() {
    let parse = tauri::Url::parse("http://").unwrap_err();
    let url = velopack::Error::Network(Box::new(NetworkError::Url(parse)));
    assert_eq!(kind(url), UpdateErrorKind::Other);
    let checksum = velopack::Error::ChecksumInvalid("a.nupkg".into(), "x".into(), "y".into());
    let mapped = map_error(checksum);
    assert_eq!(mapped.kind, UpdateErrorKind::Other);
    assert!(mapped.message.contains("a.nupkg"), "{}", mapped.message);
    assert_eq!(
        kind(velopack::Error::Io(io::ErrorKind::NotFound.into())),
        UpdateErrorKind::Other
    );
}

#[test]
fn notes_prefer_html_and_fall_back_to_markdown() {
    let html = VelopackAsset {
        Version: "2099.101.4".into(),
        NotesHtml: " <h2>Fixed</h2><p>Sync</p> ".into(),
        NotesMarkdown: "## Fixed\nSync".into(),
        ..Default::default()
    };
    let update = available_update(&html);
    assert_eq!(update.version, "2099.101.4");
    assert_eq!(
        update.release_notes_html.as_deref(),
        Some("<h2>Fixed</h2><p>Sync</p>")
    );
    assert_eq!(
        update.release_notes,
        plain_text_release_notes("<h2>Fixed</h2><p>Sync</p>")
    );

    let markdown = VelopackAsset {
        NotesMarkdown: " ## Fixed\nSync ".into(),
        ..Default::default()
    };
    let update = available_update(&markdown);
    assert_eq!(update.release_notes_html, None);
    assert_eq!(update.release_notes.as_deref(), Some("## Fixed\nSync"));

    let update = available_update(&VelopackAsset::default());
    assert_eq!(
        (update.release_notes, update.release_notes_html),
        (None, None)
    );
}
