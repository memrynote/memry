//! The CalDAV pull and push drain over a real vault and the local TLS server's object store
//! (`caldav-sync.test.ts`, `caldav-write.test.ts`): the pull's full, sync-token and ctag paths, a
//! stale token falling back to a full pull, the auth-failure mark, the rate limit; the drain's
//! create, update and delete, the two 412 paths that keep both sides, an account with no password
//! keeping items queued, and a drain cut off after its `PUT` landing exactly one object.
//! The keychain is a fake; the server is local.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memry_core::api::calendar::VaultCalendar;
use memry_core::api::calendar_records::{
    CalendarEventChanges, CalendarEventDraft, CalendarRangeRequest, CalendarTextChange,
    CalendarZone,
};
use memry_core::api::errors::AuthError;
use memry_core::protocol::account_admin::AccountDevice;
use memry_desktop::calendar_providers::caldav_accounts::CaldavAccounts;
use memry_desktop::calendar_providers::caldav_sync::CaldavSync;
use memry_desktop::calendar_providers::caldav_transport::TIMEOUT;
use memry_desktop::calendar_providers::writer_compat::{AccountDevices, SignIn};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};

use crate::caldav_server::dav::{Auth, Collection, Dav, Secrets};
use crate::caldav_server::{Harness, Reply, Seen, serve};
use crate::calendar_caldav::{PASS, USER, accounts, form};
use crate::device_key::with_device_key;

const SERVER: &str = "https://dav.example/dav/";
const WORK: &str = "https://dav.example/dav/calendars/work/";
const WORK_PATH: &str = "/dav/calendars/work/";
/// A second account on another host (the same fake server answers both).
const OTHER: &str = "https://myname.synology.me/dav/";
const OTHER_WORK: &str = "https://myname.synology.me/dav/calendars/work/";
const SERVICE: &str = "com.memrynote.memry.calendar.caldav";

type Hook = Box<dyn FnMut(&Seen, Reply) -> Reply + Send>;

struct SignedOut;

impl AccountDevices for SignedOut {
    async fn sign_in(&self) -> SignIn {
        SignIn::SignedOut
    }

    async fn devices(&self) -> Result<Vec<AccountDevice>, AuthError> {
        Ok(Vec::new())
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    session: Session,
    harness: Harness,
    dav: Arc<Dav>,
    secrets: Arc<Secrets>,
    accounts: Arc<CaldavAccounts>,
    hook: Arc<Mutex<Option<Hook>>>,
}

impl Rig {
    async fn new(sync_collection: bool) -> Self {
        let dav = Arc::new(Dav::new(
            "/dav",
            USER,
            PASS,
            Auth::Basic,
            vec![Collection::events("work", "Work")],
        ));
        dav.sync_collection
            .store(sync_collection, std::sync::atomic::Ordering::SeqCst);
        let hook: Arc<Mutex<Option<Hook>>> = Arc::new(Mutex::new(None));
        let (answer, hooked) = (dav.clone(), hook.clone());
        let harness = serve(move |seen| {
            if seen.target == "/.well-known/caldav" {
                return Reply::status(404);
            }
            let reply = answer.answer(seen);
            match hooked.lock().unwrap().as_mut() {
                Some(hook) => hook(seen, reply),
                None => reply,
            }
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("app")).unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let config = AppConfig::load(dir.path().join("app").join("memry-config.json"));
        let session = Session::new(VaultRegistry::new(Arc::new(config)));
        let secrets = Arc::new(Secrets::default());
        let accounts = Arc::new(accounts(&harness, TIMEOUT, secrets.clone()));
        Self {
            _dir: dir,
            vault,
            session,
            harness,
            dav,
            secrets,
            accounts,
            hook,
        }
    }

    async fn open(&self) -> OpenVault {
        let (session, vault) = (self.session.clone(), self.vault.clone());
        tokio::task::spawn_blocking(move || session.open(&vault, OpenSource::Select).unwrap().vault)
            .await
            .unwrap()
    }

    /// Closes the vault (every handle on it dropped, as at quit) and opens it again.
    async fn reopen(&self, open: OpenVault) -> OpenVault {
        drop(open);
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || session.close())
            .await
            .unwrap();
        self.open().await
    }

    /// Connects the account and answers `(account id, calendar source id)`.
    async fn connect(&self, open: &OpenVault) -> (String, String) {
        let account = self.connect_to(open, SERVER).await;
        let source = calendar(open)
            .sources()
            .unwrap()
            .into_iter()
            .find(|s| s.remote_id == WORK)
            .unwrap();
        (account, source.id)
    }

    async fn connect_to(&self, open: &OpenVault, server: &str) -> String {
        self.accounts
            .connect(&self.session, open, &form(server), &SignedOut)
            .await
            .unwrap()
    }

    fn sync(&self) -> Arc<CaldavSync> {
        self.accounts.sync()
    }

    fn set_hook(&self, hook: impl FnMut(&Seen, Reply) -> Reply + Send + 'static) {
        *self.hook.lock().unwrap() = Some(Box::new(hook));
    }

    fn clear_hook(&self) {
        *self.hook.lock().unwrap() = None;
    }

    /// The requests since `mark`.
    fn since(&self, mark: usize) -> Vec<Seen> {
        self.harness.seen().split_off(mark)
    }
}

fn calendar(open: &OpenVault) -> Arc<VaultCalendar> {
    open.vault.calendar(with_device_key()).unwrap()
}

fn utc() -> CalendarZone {
    CalendarZone {
        identifier: "UTC".to_owned(),
        base_offset_ms: 0,
        transitions: Vec::new(),
    }
}

fn tomorrow() -> jiff::Timestamp {
    let now = jiff::Timestamp::now().as_second();
    jiff::Timestamp::from_second(now - now % 3600 + 86_400).unwrap()
}

fn ics(uid: &str, title: &str) -> String {
    let start = tomorrow();
    let end = start + jiff::SignedDuration::from_hours(1);
    let at = |t: jiff::Timestamp| t.strftime("%Y%m%dT%H%M%SZ").to_string();
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//caldav//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\n\
         DTSTAMP:{0}\r\nDTSTART:{0}\r\nDTEND:{1}\r\nSUMMARY:{title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        at(start),
        at(end)
    )
}

/// Titles the calendar shows over the next two days, by source type.
fn titles(open: &OpenVault, source_type: &str) -> Vec<String> {
    let start = jiff::Timestamp::now();
    let end = start + jiff::SignedDuration::from_hours(72);
    let request = CalendarRangeRequest {
        start_at: start.to_string(),
        end_at: end.to_string(),
        include_unselected_sources: true,
        enabled_property_names: Vec::new(),
        show_notes_by_created: false,
    };
    let mut titles: Vec<String> = calendar(open)
        .range(request, utc())
        .unwrap()
        .into_iter()
        .filter(|i| i.source_type == source_type)
        .map(|i| i.title)
        .collect();
    titles.sort();
    titles
}

fn new_event(open: &OpenVault, title: &str) -> String {
    new_event_in(open, title, WORK)
}

fn new_event_in(open: &OpenVault, title: &str, target: &str) -> String {
    calendar(open)
        .create_event(CalendarEventDraft {
            title: title.to_owned(),
            description: None,
            location: None,
            start_at: tomorrow().to_string(),
            end_at: Some((tomorrow() + jiff::SignedDuration::from_hours(1)).to_string()),
            timezone: "UTC".to_owned(),
            is_all_day: false,
            target_calendar_id: Some(target.to_owned()),
            color: None,
        })
        .unwrap()
        .id
}

fn retitle(open: &OpenVault, id: &str, title: &str) {
    calendar(open)
        .update_event(
            id.to_owned(),
            CalendarEventChanges {
                title: Some(title.to_owned()),
                description: CalendarTextChange::Keep,
                location: CalendarTextChange::Keep,
                start_at: None,
                end_at: CalendarTextChange::Keep,
                timezone: None,
                is_all_day: None,
                target_calendar_id: CalendarTextChange::Keep,
                color: CalendarTextChange::Keep,
            },
        )
        .unwrap();
}

fn queued(open: &OpenVault) -> Vec<String> {
    calendar(open)
        .push_queue()
        .unwrap()
        .into_iter()
        .map(|q| q.source_id)
        .collect()
}

fn cursor(open: &OpenVault, source: &str) -> Option<String> {
    calendar(open)
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.id == source)
        .and_then(|s| s.sync_cursor)
}

fn writes(seen: &[Seen], method: &str) -> Vec<Seen> {
    seen.iter()
        .filter(|s| s.method == method)
        .cloned()
        .collect()
}

/// The one object the drain created in the calendar.
fn only_object(rig: &Rig) -> String {
    let paths = rig.dav.store.paths();
    assert_eq!(paths.len(), 1, "{paths:?}");
    paths[0].clone()
}

#[tokio::test]
async fn pull_goes_full_then_by_token_and_a_stale_token_pulls_in_full() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    let (_, source) = rig.connect(&open).await;
    let a = format!("{WORK_PATH}a.ics");
    rig.dav.store.put_remote(&a, &ics("a", "Alpha"));

    let mark = rig.harness.seen().len();
    rig.sync().sync_source(&open, &source).await.unwrap();
    assert_eq!(titles(&open, "external_event"), ["Alpha"]);
    assert_eq!(cursor(&open, &source).as_deref(), Some("sync-token:tok-1"));
    assert!(
        rig.since(mark)
            .iter()
            .any(|s| s.body.contains("calendar-query"))
    );

    let b = format!("{WORK_PATH}b.ics");
    rig.dav.store.put_remote(&b, &ics("b", "Beta"));
    rig.dav.store.put_remote(&a, &ics("a", "Alpha 2"));
    let mark = rig.harness.seen().len();
    rig.sync().sync_source(&open, &source).await.unwrap();
    let seen = rig.since(mark);
    assert!(
        seen.iter()
            .any(|s| s.body.contains("<d:sync-token>tok-1</d:sync-token>"))
    );
    let multiget = seen
        .iter()
        .find(|s| s.body.contains("calendar-multiget"))
        .unwrap();
    assert!(multiget.body.contains(&a) && multiget.body.contains(&b));
    assert!(!seen.iter().any(|s| s.body.contains("calendar-query")));
    assert_eq!(titles(&open, "external_event"), ["Alpha 2", "Beta"]);

    rig.dav.store.delete_remote(&b);
    rig.sync().sync_source(&open, &source).await.unwrap();
    assert_eq!(titles(&open, "external_event"), ["Alpha 2"]);

    rig.dav.store.expire_tokens();
    rig.dav
        .store
        .put_remote(&format!("{WORK_PATH}c.ics"), &ics("c", "Gamma"));
    let mark = rig.harness.seen().len();
    rig.sync().sync_source(&open, &source).await.unwrap();
    let seen = rig.since(mark);
    assert!(seen.iter().any(|s| s.body.contains("calendar-query")));
    assert_eq!(titles(&open, "external_event"), ["Alpha 2", "Gamma"]);
    assert_eq!(cursor(&open, &source).as_deref(), Some("sync-token:tok-5"));
}

#[tokio::test]
async fn pull_by_ctag_queries_only_when_the_ctag_moved() {
    let rig = Rig::new(false).await;
    let open = rig.open().await;
    let (_, source) = rig.connect(&open).await;
    let a = format!("{WORK_PATH}a.ics");
    rig.dav.store.put_remote(&a, &ics("a", "Alpha"));
    rig.sync().sync_source(&open, &source).await.unwrap();
    assert_eq!(cursor(&open, &source).as_deref(), Some("ctag:1"));

    let mark = rig.harness.seen().len();
    rig.sync().sync_source(&open, &source).await.unwrap();
    assert!(!rig.since(mark).iter().any(|s| s.method == "REPORT"));

    rig.dav.store.put_remote(&a, &ics("a", "Alpha 2"));
    rig.sync().sync_source(&open, &source).await.unwrap();
    assert_eq!(titles(&open, "external_event"), ["Alpha 2"]);
    assert_eq!(cursor(&open, &source).as_deref(), Some("ctag:2"));
}

#[tokio::test]
async fn a_refused_password_marks_the_account_holds_its_writes_and_a_good_pull_clears_it() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    let (account, source) = rig.connect(&open).await;
    let id = new_event(&open, "Standup");
    rig.set_hook(|seen, reply| {
        if seen.method == "REPORT" {
            Reply::status(401)
        } else {
            reply
        }
    });
    let error = rig.sync().sync_source(&open, &source).await.unwrap_err();
    assert!(error.is_auth(), "{error}");
    let marks = rig.sync().auth_failures(&open).await.unwrap();
    assert_eq!(marks.get(&account), Some(&serde_json::Value::Bool(true)));

    let mark = rig.harness.seen().len();
    let summary = rig.sync().drain(&open).await.unwrap();
    assert_eq!(summary.waiting, 1);
    assert!(rig.since(mark).is_empty(), "a marked account sends nothing");
    assert_eq!(queued(&open), std::slice::from_ref(&id));

    rig.clear_hook();
    rig.sync().sync_source(&open, &source).await.unwrap();
    assert!(rig.sync().auth_failures(&open).await.unwrap().is_empty());
    assert_eq!(rig.sync().drain(&open).await.unwrap().pushed, 1);
    assert!(queued(&open).is_empty());
}

#[tokio::test]
async fn a_rate_limit_stops_the_pass_and_names_the_wait() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    rig.connect(&open).await;
    rig.set_hook(|seen, reply| {
        if seen.method == "REPORT" {
            Reply::status(429).with_header("retry-after", "7")
        } else {
            reply
        }
    });
    let summary = rig.sync().sync_now(&open, None).await.unwrap();
    assert_eq!(summary.failed, 1);
    assert_eq!(summary.retry_after_ms, Some(7_000));
}

#[tokio::test]
async fn a_drain_creates_then_updates_with_if_match() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    rig.connect(&open).await;
    let id = new_event(&open, "Standup");
    assert_eq!(rig.sync().drain(&open).await.unwrap().pushed, 1);
    assert!(queued(&open).is_empty());
    let path = only_object(&rig);
    let (etag, data) = rig.dav.store.object(&path).unwrap();
    assert!(data.contains("SUMMARY:Standup"));
    let create = writes(&rig.harness.seen(), "PUT");
    assert_eq!(create.len(), 1);
    assert_eq!(create[0].if_none_match.as_deref(), Some("*"));

    retitle(&open, &id, "Retro");
    assert_eq!(rig.sync().drain(&open).await.unwrap().pushed, 1);
    let puts = writes(&rig.harness.seen(), "PUT");
    assert_eq!(puts.len(), 2);
    assert_eq!(puts[1].target, path);
    assert_eq!(puts[1].if_match.as_deref(), Some(etag.as_str()));
    assert!(
        rig.dav
            .store
            .object(&path)
            .unwrap()
            .1
            .contains("SUMMARY:Retro")
    );
    assert_eq!(only_object(&rig), path);
}

#[tokio::test]
async fn a_412_update_overwrites_neither_side_and_keeps_the_item_queued() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    rig.connect(&open).await;
    let id = new_event(&open, "Standup");
    rig.sync().drain(&open).await.unwrap();
    let path = only_object(&rig);
    let remote = rig
        .dav
        .store
        .object(&path)
        .unwrap()
        .1
        .replace("SUMMARY:Standup", "SUMMARY:Remote");
    rig.dav.store.put_remote(&path, &remote);

    retitle(&open, &id, "Local");
    let summary = rig.sync().drain(&open).await.unwrap();
    assert_eq!(summary.failed, 1);
    assert_eq!(writes(&rig.harness.seen(), "PUT").len(), 2);
    assert!(
        rig.dav
            .store
            .object(&path)
            .unwrap()
            .1
            .contains("SUMMARY:Remote")
    );
    assert_eq!(titles(&open, "event"), ["Local"]);
    assert_eq!(queued(&open), [id]);
}

#[tokio::test]
async fn a_412_delete_keeps_the_remote_object_and_sends_no_second_delete() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    rig.connect(&open).await;
    let id = new_event(&open, "Standup");
    rig.sync().drain(&open).await.unwrap();
    let path = only_object(&rig);
    let remote = rig
        .dav
        .store
        .object(&path)
        .unwrap()
        .1
        .replace("SUMMARY:Standup", "SUMMARY:Remote");
    rig.dav.store.put_remote(&path, &remote);

    calendar(&open).delete_event(id).unwrap();
    assert_eq!(rig.sync().drain(&open).await.unwrap().pushed, 1);
    assert_eq!(writes(&rig.harness.seen(), "DELETE").len(), 1);
    assert!(
        rig.dav
            .store
            .object(&path)
            .unwrap()
            .1
            .contains("SUMMARY:Remote")
    );
    assert!(queued(&open).is_empty());
}

#[tokio::test]
async fn an_account_with_no_password_here_keeps_its_items_queued_without_a_request() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    rig.connect(&open).await;
    // The other account's password is gone; this one's still lets the drain run.
    let other = rig.connect_to(&open, OTHER).await;
    let id = new_event_in(&open, "Standup", OTHER_WORK);
    let key = (SERVICE.to_owned(), format!("password-{other}"));
    assert!(rig.secrets.0.lock().unwrap().remove(&key).is_some());
    let mark = rig.harness.seen().len();
    let summary = rig.sync().drain(&open).await.unwrap();
    assert_eq!(summary.waiting, 1);
    assert!(rig.since(mark).is_empty());
    assert_eq!(queued(&open), [id]);
}

/// The app dies after the server stored the `PUT` but before the binding was recorded: the next
/// open's drain finds the object the journal names and sends nothing.
#[tokio::test]
async fn a_drain_cut_off_after_its_put_lands_one_object_after_a_restart() {
    let rig = Rig::new(true).await;
    let open = rig.open().await;
    let id = new_event(&open, "Standup");
    let open = rig.reopen(open).await;
    assert_eq!(
        queued(&open),
        std::slice::from_ref(&id),
        "the queue survives a close"
    );
    rig.connect(&open).await;

    let landed = Arc::new(tokio::sync::Notify::new());
    let (signal, never) = (landed.clone(), Arc::new(tokio::sync::Notify::new()));
    rig.set_hook(move |seen, reply| {
        if seen.method != "PUT" {
            return reply;
        }
        signal.notify_one();
        Reply::Gated {
            gate: never.clone(),
            then: Box::new(reply),
        }
    });
    let (sync, cut) = (rig.sync(), open.clone());
    let drain = tokio::spawn(async move { sync.drain(&cut).await });
    landed.notified().await;
    drain.abort();
    assert!(drain.await.unwrap_err().is_cancelled());
    rig.clear_hook();
    assert_eq!(rig.dav.store.paths().len(), 1, "the PUT landed");

    let open = rig.reopen(open).await;
    assert_eq!(queued(&open), std::slice::from_ref(&id));
    let summary = rig.sync().drain(&open).await.unwrap();
    assert_eq!(summary.pushed, 1);
    assert_eq!(writes(&rig.harness.seen(), "PUT").len(), 1);
    let path = only_object(&rig);
    assert!(queued(&open).is_empty());

    // The binding was recorded: the next edit updates that object.
    retitle(&open, &id, "Retro");
    rig.sync().drain(&open).await.unwrap();
    let puts = writes(&rig.harness.seen(), "PUT");
    assert_eq!(puts.len(), 2);
    assert_eq!(puts[1].target, path);
    assert!(puts[1].if_match.is_some());
    assert_eq!(only_object(&rig), path);
}
