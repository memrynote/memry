//! `IcsFetcher` against a local TLS server standing in for `feeds.example` (and a plain-HTTP one
//! on `127.0.0.1`), through the app's
//! own HTTP builder: the conditional GET, the status codes, the redirect checks, the size cap and
//! the deadline of `ics/ics-fetch.ts` (`ics-fetch.test.ts`).

use std::time::Duration;

use memry_desktop::calendar_providers::ics_fetch::{
    Fetched, IcsFeedCode, IcsFetcher, MAX_FEED_BYTES, TIMEOUT,
};

use crate::on_warning::logged;
use crate::unsplash_server::{Harness, Reply, Seen, serve, serve_plain};

const FEED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

fn fetcher(h: &Harness) -> IcsFetcher {
    IcsFetcher::new(h.builder(), TIMEOUT).expect("client")
}

fn redirect(to: &str) -> Reply {
    Reply::status(302).with_header("location", to)
}

/// `/hop/<n>` redirects to `/hop/<n-1>`; `/hop/0` is the feed.
fn hops(seen: &Seen) -> Reply {
    let n: usize = seen
        .target
        .strip_prefix("/hop/")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    if n == 0 {
        feed_body()
    } else {
        redirect(&format!("/hop/{}", n - 1))
    }
}

#[tokio::test]
async fn a_feed_comes_back_with_its_validators_and_the_accept_header() {
    let h = serve(|_| Reply::Ok {
        status: 200,
        headers: vec![
            ("etag", "\"v1\"".to_owned()),
            ("last-modified", "Tue, 01 Sep 2026 10:00:00 GMT".to_owned()),
        ],
        body: [b"\xef\xbb\xbf".as_slice(), FEED.as_bytes()].concat(),
    })
    .await;
    let Ok(Fetched::Body(feed)) = fetcher(&h)
        .fetch("https://feeds.example/team.ics", None, None)
        .await
    else {
        panic!("a body");
    };
    assert_eq!(
        feed.text, FEED,
        "the BOM is dropped as TextDecoder drops it"
    );
    assert_eq!(feed.etag.as_deref(), Some("\"v1\""));
    assert_eq!(
        feed.last_modified.as_deref(),
        Some("Tue, 01 Sep 2026 10:00:00 GMT")
    );
    let seen = h.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].host, "feeds.example");
    assert_eq!(
        seen[0].accept.as_deref(),
        Some("text/calendar, text/plain;q=0.9, */*;q=0.5")
    );
    assert_eq!(seen[0].if_none_match, None);
}

#[tokio::test]
async fn the_validators_make_the_get_conditional() {
    let h = serve(|_| Reply::status(304)).await;
    let fetched = fetcher(&h)
        .fetch(
            "https://feeds.example/team.ics",
            Some("\"v1\""),
            Some("Tue, 01 Sep 2026 10:00:00 GMT"),
        )
        .await;
    assert_eq!(fetched, Ok(Fetched::NotModified));
    let seen = h.seen();
    assert_eq!(seen[0].if_none_match.as_deref(), Some("\"v1\""));
    assert_eq!(
        seen[0].if_modified_since.as_deref(),
        Some("Tue, 01 Sep 2026 10:00:00 GMT")
    );
}

#[tokio::test]
async fn statuses_map_to_the_feed_codes() {
    let h = serve(|seen| {
        let status = seen.target.trim_start_matches('/').parse().unwrap_or(500);
        Reply::status(status)
    })
    .await;
    let fetcher = fetcher(&h);
    for (status, code) in [
        (404, IcsFeedCode::NotFound),
        (410, IcsFeedCode::NotFound),
        (401, IcsFeedCode::Unauthorized),
        (403, IcsFeedCode::Unauthorized),
        (500, IcsFeedCode::HttpError),
        (429, IcsFeedCode::HttpError),
    ] {
        assert_eq!(
            fetcher
                .fetch(&format!("https://feeds.example/{status}"), None, None)
                .await,
            Err(code),
            "{status}"
        );
    }
}

#[tokio::test]
async fn five_redirects_are_followed_and_a_sixth_is_refused() {
    let h = serve(hops).await;
    let fetcher = fetcher(&h);
    assert!(matches!(
        fetcher
            .fetch("https://feeds.example/hop/5", None, None)
            .await,
        Ok(Fetched::Body(_))
    ));
    assert_eq!(h.seen().len(), 6);
    assert_eq!(
        fetcher
            .fetch("https://feeds.example/hop/6", None, None)
            .await,
        Err(IcsFeedCode::TooManyRedirects)
    );
    assert_eq!(h.seen().len(), 6 + 6, "the seventh hop is never requested");
}

fn feed_body() -> Reply {
    Reply::Ok {
        status: 200,
        headers: Vec::new(),
        body: FEED.as_bytes().to_vec(),
    }
}

/// Electron follows a redirect to `http:` (`ics-fetch.ts:43`); one off the web is refused.
#[tokio::test]
async fn a_redirect_to_http_is_followed_and_one_off_the_web_is_refused() {
    let plain = serve_plain(|_| feed_body()).await;
    let to_http = plain.url("/team.ics");
    let h = serve(move |seen| match seen.target.as_str() {
        "/to-http" => redirect(&to_http),
        "/to-ftp" => redirect("ftp://feeds.example/x"),
        "/to-file" => redirect("file:///etc/passwd"),
        "/to-webcal" => redirect("webcal://feeds.example/x"),
        _ => Reply::status(302),
    })
    .await;
    let fetcher = fetcher(&h);
    assert!(matches!(
        fetcher
            .fetch("https://feeds.example/to-http", None, None)
            .await,
        Ok(Fetched::Body(_))
    ));
    assert_eq!(plain.seen().len(), 1, "the http hop was requested");
    for (path, code) in [
        ("/to-ftp", IcsFeedCode::UnsupportedRedirect),
        ("/to-file", IcsFeedCode::UnsupportedRedirect),
        ("/to-webcal", IcsFeedCode::UnsupportedRedirect),
        ("/no-location", IcsFeedCode::HttpError),
    ] {
        assert_eq!(
            fetcher
                .fetch(&format!("https://feeds.example{path}"), None, None)
                .await,
            Err(code),
            "{path}"
        );
    }
    assert_eq!(h.seen().len(), 5, "no hop after a refused redirect");
    assert_eq!(plain.seen().len(), 1);
}

/// Electron accepts `http:` links (`ics-feed.ts:50`).
#[tokio::test]
async fn an_http_feed_is_fetched_and_a_link_off_the_web_is_refused_without_a_request() {
    let plain = serve_plain(|_| feed_body()).await;
    let h = serve(|_| Reply::status(200)).await;
    let fetcher = fetcher(&h);
    let Ok(Fetched::Body(feed)) = fetcher.fetch(&plain.url("/team.ics"), None, None).await else {
        panic!("an http feed is fetched");
    };
    assert_eq!(feed.text, FEED);
    for url in ["ftp://feeds.example/x", "file:///etc/passwd", "nope"] {
        assert_eq!(
            fetcher.fetch(url, None, None).await,
            Err(IcsFeedCode::InvalidUrl),
            "{url}"
        );
    }
    assert!(h.seen().is_empty());
    assert_eq!(plain.seen().len(), 1);
}

/// A private feed link carries its token in the path or the query: a failed request is logged
/// without the link.
#[test]
fn a_failed_request_logs_no_part_of_the_link() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .expect("a free port")
        .port();
    let url = format!("https://127.0.0.1:{closed}/private-SECRETTOKEN/basic.ics?token=QSECRET");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let (fetched, lines) = logged("memry_desktop::calendar_providers::ics_fetch", || {
        runtime.block_on(async {
            IcsFetcher::new(memry_desktop::http::builder(), TIMEOUT)
                .expect("client")
                .fetch(&url, None, None)
                .await
        })
    });
    assert_eq!(fetched, Err(IcsFeedCode::Unreachable));
    assert!(
        lines.iter().any(|l| l.contains("feed request failed")),
        "the failure is logged: {lines:?}"
    );
    assert!(
        lines
            .iter()
            .all(|l| !l.contains("SECRET") && !l.contains("basic.ics")),
        "{lines:?}"
    );
}

#[tokio::test]
async fn a_body_over_the_cap_is_too_large_declared_or_not() {
    let h = serve(|seen| match seen.target.as_str() {
        "/declared" => Reply::Ok {
            status: 200,
            headers: Vec::new(),
            body: vec![b'x'; MAX_FEED_BYTES + 1],
        },
        "/streamed" => Reply::Undeclared {
            head: "BEGIN:VCALENDAR\r\n",
            bytes: MAX_FEED_BYTES,
            tail: "END:VCALENDAR\r\n",
        },
        _ => Reply::Ok {
            status: 200,
            headers: Vec::new(),
            body: vec![b'x'; MAX_FEED_BYTES],
        },
    })
    .await;
    let fetcher = fetcher(&h);
    for path in ["/declared", "/streamed"] {
        assert_eq!(
            fetcher
                .fetch(&format!("https://feeds.example{path}"), None, None)
                .await,
            Err(IcsFeedCode::TooLarge),
            "{path}"
        );
    }
    assert!(matches!(
        fetcher
            .fetch("https://feeds.example/at-cap", None, None)
            .await,
        Ok(Fetched::Body(_))
    ));
}

#[tokio::test]
async fn a_stalled_host_times_out_and_a_closed_one_is_unreachable() {
    let h = serve(|seen| match seen.target.as_str() {
        "/stall" => Reply::Stall,
        _ => Reply::Hangup,
    })
    .await;
    let fetcher = IcsFetcher::new(h.builder(), Duration::from_millis(300)).expect("client");
    assert_eq!(
        fetcher
            .fetch("https://feeds.example/stall", None, None)
            .await,
        Err(IcsFeedCode::Timeout)
    );
    assert_eq!(
        fetcher
            .fetch("https://feeds.example/hangup", None, None)
            .await,
        Err(IcsFeedCode::Unreachable)
    );
}
