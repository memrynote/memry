//! CalDAV discovery and its transport against a local TLS server (`caldav-transport.test.ts`,
//! `caldav-client.test.ts`, `caldav-connect.test.ts`): iCloud's partition redirect, credentials
//! that never leave the account's hosts, Digest, the redirect and body caps, and the connect
//! form's failure codes. Never a real provider.

use std::sync::Arc;
use std::time::Duration;

use memry_desktop::calendar_providers::caldav_accounts::{
    BasicConnection, CaldavAccounts, CaldavError,
};
use memry_desktop::calendar_providers::caldav_discover::ConnectCode;
use memry_desktop::calendar_providers::caldav_transport::{
    CaldavHttp, DavRequest, MAX_BODY, TIMEOUT, Transport, TransportError,
};
use memry_desktop::calendar_providers::credentials::ProviderCredentials;
use reqwest::Method;
use url::Url;

use crate::caldav_server::dav::{Auth, Collection, Dav, Secrets, basic_header};
use crate::caldav_server::{Harness, Reply, serve};
use crate::device_key::with_device_key;

pub const USER: &str = "u@example.com";
/// A made-up app password.
pub const PASS: &str = "pw-1-memry-caldav-test";

pub fn form(server: &str) -> BasicConnection {
    BasicConnection {
        server_url: server.to_owned(),
        username: format!(" {USER} "),
        password: PASS.to_owned().into(),
        preset: None,
        selected_calendar_ids: None,
        acknowledge_outdated_devices: false,
    }
    .checked()
    .unwrap()
}

pub fn accounts(harness: &Harness, timeout: Duration, secrets: Arc<Secrets>) -> CaldavAccounts {
    CaldavAccounts::new(
        CaldavHttp::new(harness.builder(), timeout).unwrap(),
        ProviderCredentials::new(secrets, None),
        with_device_key(),
    )
}

fn transport(harness: &Harness, server: &str) -> Transport {
    CaldavHttp::new(harness.builder(), TIMEOUT)
        .unwrap()
        .transport(&Url::parse(server).unwrap(), USER, PASS)
}

fn request(method: Method, url: &str) -> DavRequest {
    DavRequest {
        method,
        url: Url::parse(url).unwrap(),
        depth: None,
        body: Some("<x/>".to_owned()),
        follow: true,
        headers: Vec::new(),
    }
}

async fn code(accounts: &CaldavAccounts, server: &str) -> ConnectCode {
    match accounts.discover(&form(server)).await {
        Err(CaldavError::Connect(code)) => code,
        Err(other) => panic!("{server}: {other}"),
        Ok(_) => panic!("{server}: discovery succeeded"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
/// iCloud's shape (a well-known redirect to a per-account partition host) on another
/// multi-host provider domain: macOS pins `*.icloud.com` to Apple's certificates, so no local
/// server can stand in for it there.
async fn icloud_discovery_follows_the_partition_host_with_credentials_and_skips_task_lists() {
    let dav = Dav::new(
        "/123",
        USER,
        PASS,
        Auth::Basic,
        vec![
            Collection::events("work", "Work"),
            Collection::tasks("reminders", "Reminders"),
        ],
    );
    let harness = serve(
        move |seen| match (seen.host.as_str(), seen.target.as_str()) {
            ("caldav.fastmail.com", "/.well-known/caldav") => {
                Reply::redirect(301, "https://p67-caldav.fastmail.com/123/")
            }
            ("p67-caldav.fastmail.com", _) => dav.answer(seen),
            _ => Reply::status(404),
        },
    )
    .await;
    let found = accounts(&harness, TIMEOUT, Arc::default())
        .discover(&form("caldav.fastmail.com"))
        .await
        .unwrap();
    assert_eq!(found.server_url, "https://caldav.fastmail.com/");
    let info = &found.info;
    assert_eq!(
        info.principal_url,
        "https://p67-caldav.fastmail.com/123/principal/"
    );
    assert_eq!(
        info.home_url,
        "https://p67-caldav.fastmail.com/123/calendars/"
    );
    let calendars = info
        .calendars
        .iter()
        .map(|c| (c.url.as_str(), c.display_name.as_str(), c.color.as_deref()))
        .collect::<Vec<_>>();
    assert_eq!(
        calendars,
        [(
            "https://p67-caldav.fastmail.com/123/calendars/work/",
            "Work",
            Some("#ff2968")
        )],
        "the VTODO-only list is skipped"
    );
    let partition = harness
        .seen()
        .into_iter()
        .filter(|s| s.host == "p67-caldav.fastmail.com")
        .collect::<Vec<_>>();
    let basic = basic_header(USER, PASS);
    assert_eq!(partition.len(), 3, "principal, home, listing");
    assert!(
        partition
            .iter()
            .all(|s| s.method == "PROPFIND" && s.authorization.as_deref() == Some(basic.as_str()))
    );
    let listing = &partition[2];
    assert_eq!(listing.depth.as_deref(), Some("1"));
    assert!(listing.body.contains("supported-calendar-component-set"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redirect_off_the_account_never_carries_the_password() {
    let harness = serve(|seen| match (seen.host.as_str(), seen.target.as_str()) {
        (_, "/.well-known/caldav") => Reply::status(404),
        ("dav.example", "/leak/") => Reply::redirect(307, "https://x:y@evil.example/collect/"),
        ("dav.example", _) => Reply::redirect(307, "https://evil.example/collect/"),
        ("myname.synology.me", _) => Reply::redirect(301, "https://other.synology.me/collect/"),
        _ => Reply::status(401),
    })
    .await;
    let accounts = accounts(&harness, TIMEOUT, Arc::default());
    for server in [
        "https://dav.example/dav/",
        "https://dav.example/leak/",
        "https://myname.synology.me/dav/",
    ] {
        assert_eq!(code(&accounts, server).await, ConnectCode::Unauthorized);
    }
    let seen = harness.seen();
    let offsite = seen
        .iter()
        .filter(|s| matches!(s.host.as_str(), "evil.example" | "other.synology.me"))
        .collect::<Vec<_>>();
    assert!(!offsite.is_empty());
    assert!(
        offsite.iter().all(|s| s.authorization.is_none()),
        "{offsite:?}"
    );
    assert!(
        seen.iter()
            .filter(|s| matches!(s.host.as_str(), "dav.example" | "myname.synology.me"))
            .all(|s| s.authorization.is_some())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_url_with_credentials_in_it_is_refused_before_any_request() {
    let harness = serve(|_| Reply::status(404)).await;
    let accounts = accounts(&harness, TIMEOUT, Arc::default());
    for server in [
        "https://u:p@dav.example/dav/",
        "https://u@dav.example/dav/",
        "u:p@dav.example/dav/",
    ] {
        assert_eq!(
            code(&accounts, server).await,
            ConnectCode::InvalidUrl,
            "{server}"
        );
    }
    assert!(harness.seen().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_digest_only_server_is_answered_from_its_challenge() {
    let dav = Dav::new(
        "/dav",
        USER,
        PASS,
        Auth::Digest,
        vec![Collection::events("home", "Home")],
    );
    let harness = serve(move |seen| {
        if seen.target == "/.well-known/caldav" {
            Reply::status(404)
        } else {
            dav.answer(seen)
        }
    })
    .await;
    let found = accounts(&harness, TIMEOUT, Arc::default())
        .discover(&form("https://dav.example/dav/"))
        .await
        .unwrap();
    assert_eq!(found.info.calendars.len(), 1);
    let digests = harness
        .seen()
        .into_iter()
        .filter_map(|s| s.authorization)
        .filter(|a| a.starts_with("Digest "))
        .collect::<Vec<_>>();
    assert_eq!(
        digests.len(),
        3,
        "principal (after the challenge), home, listing"
    );
    let counts = digests
        .iter()
        .map(|d| d.split("nc=").nth(1).unwrap()[..8].to_owned())
        .collect::<Vec<_>>();
    assert_eq!(counts, ["00000001", "00000002", "00000003"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sixth_redirect_is_handed_back_and_a_303_turns_into_a_get() {
    let harness = serve(|seen| {
        if seen.target == "/see-other" {
            return Reply::redirect(303, "/after");
        }
        let hop = seen
            .target
            .strip_prefix("/hop/")
            .and_then(|n| n.parse::<usize>().ok());
        match hop {
            Some(n) if n < 50 => Reply::redirect(302, &format!("/hop/{}", n + 1)),
            _ => Reply::status(200),
        }
    })
    .await;
    let transport = transport(&harness, "https://dav.example/");
    let reply = transport
        .request(request(Method::GET, "https://dav.example/hop/0"))
        .await
        .unwrap();
    assert_eq!(reply.status, 302);
    assert_eq!(harness.seen().len(), 6, "the request and five redirects");

    let propfind = Method::from_bytes(b"PROPFIND").unwrap();
    let reply = transport
        .request(request(propfind, "https://dav.example/see-other"))
        .await
        .unwrap();
    assert_eq!(reply.status, 200);
    let after = harness.seen().pop().unwrap();
    assert_eq!(
        (
            after.method.as_str(),
            after.target.as_str(),
            after.body.as_str()
        ),
        ("GET", "/after", "")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_past_the_body_cap_is_refused() {
    let harness = serve(|_| Reply::Ok {
        status: 207,
        headers: vec![("content-type", "application/xml".to_owned())],
        body: vec![b' '; MAX_BODY + 1],
    })
    .await;
    let refused = transport(&harness, "https://dav.example/")
        .request(request(Method::GET, "https://dav.example/big"))
        .await;
    assert!(
        matches!(refused, Err(TransportError::TooLarge(MAX_BODY))),
        "{refused:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failures_read_as_the_connect_form_codes() {
    let tasks_only = Dav::new(
        "/tasks",
        USER,
        PASS,
        Auth::Basic,
        vec![Collection::tasks("todo", "To do")],
    );
    let harness = serve(move |seen| {
        let path = seen.target.as_str();
        if seen.host == "myname.synology.me" {
            return Reply::Stall;
        }
        if path == "/.well-known/caldav" || path == "/" {
            return Reply::status(404);
        }
        match path.split('/').nth(1).unwrap_or_default() {
            "refused" => Reply::status(401),
            "forbidden" => Reply::status(403),
            "down" => Reply::status(503),
            "busy" => Reply::status(429).with_header("retry-after", "30"),
            "html" => Reply::Ok {
                status: 200,
                headers: vec![("content-type", "text/html".to_owned())],
                body: b"<html><body>Welcome</body></html>".to_vec(),
            },
            "tasks" => tasks_only.answer(seen),
            _ => Reply::status(404),
        }
    })
    .await;
    let accounts = accounts(&harness, Duration::from_millis(300), Arc::default());
    for (server, expected) in [
        ("https://dav.example/refused/", ConnectCode::Unauthorized),
        ("https://dav.example/forbidden/", ConnectCode::Unauthorized),
        ("https://dav.example/down/", ConnectCode::Unreachable),
        ("https://dav.example/busy/", ConnectCode::Unreachable),
        ("https://dav.example/html/", ConnectCode::NotCaldav),
        ("https://dav.example/tasks/", ConnectCode::NoCalendars),
        ("https://myname.synology.me/", ConnectCode::Unreachable),
        ("ftp://dav.example/", ConnectCode::InvalidUrl),
    ] {
        let found = code(&accounts, server).await;
        assert_eq!(found, expected, "{server}");
    }
}
