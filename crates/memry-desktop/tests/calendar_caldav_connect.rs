//! The CalDAV connect flow over a real vault (`caldav-connect.test.ts`, `caldav-provider.ts`,
//! `writer-compat.test.ts`, `status.ts`): connect writes the synced rows and keeps the password in
//! this device's keychain only, reconnect keeps each calendar's choice, disconnect archives and
//! forgets, the writer check holds a connect, and a vault closed during discovery takes no write.
//! The keychain and the account's devices are fakes; the server is local.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::api::calendar_records::CalendarSourceRecord;
use memry_core::api::errors::AuthError;
use memry_core::domain::calendar_items::providers::caldav::account_id;
use memry_core::protocol::account_admin::AccountDevice;
use memry_desktop::calendar_providers::caldav_accounts::{
    BasicConnection, CaldavAccounts, CaldavError,
};
use memry_desktop::calendar_providers::caldav_discover::ConnectCode;
use memry_desktop::calendar_providers::caldav_transport::TIMEOUT;
use memry_desktop::calendar_providers::provider_status::{AccountConnection, ReconnectReason};
use memry_desktop::calendar_providers::writer_compat::{self, AccountDevices, SignIn};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};

use crate::caldav_server::dav::{Auth, Collection, Dav, Secrets};
use crate::caldav_server::{Harness, Reply, serve};
use crate::calendar_caldav::{PASS, USER, accounts, form};
use crate::device_key::with_device_key;

const SERVER: &str = "https://dav.example/dav/";
const SERVICE: &str = "com.memrynote.memry.calendar.caldav";
const WORK: &str = "https://dav.example/dav/calendars/work/";

struct Devices {
    sign_in: SignIn,
    devices: Option<Vec<AccountDevice>>,
    reads: AtomicUsize,
}

impl Devices {
    fn signed_out() -> Self {
        Self::of(SignIn::SignedOut, Some(Vec::new()))
    }

    fn of(sign_in: SignIn, devices: Option<Vec<AccountDevice>>) -> Self {
        Self {
            sign_in,
            devices,
            reads: AtomicUsize::new(0),
        }
    }
}

impl AccountDevices for Devices {
    async fn sign_in(&self) -> SignIn {
        self.sign_in
    }

    async fn devices(&self) -> Result<Vec<AccountDevice>, AuthError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.devices.clone().ok_or(AuthError::MalformedToken {
            what: "no device list".to_owned(),
        })
    }
}

fn device(id: &str, platform: &str, version: Option<&str>, current: bool) -> AccountDevice {
    AccountDevice {
        id: id.to_owned(),
        name: format!("{id}'s device"),
        platform: platform.to_owned(),
        form_factor: None,
        app_version: version.map(str::to_owned),
        last_sync_at: None,
        created_at: None,
        is_current: current,
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
    gate: Arc<tokio::sync::Notify>,
    hold_listing: Arc<std::sync::atomic::AtomicBool>,
}

impl Rig {
    async fn new() -> Self {
        let dav = Arc::new(Dav::new(
            "/dav",
            USER,
            PASS,
            Auth::Basic,
            vec![
                Collection::events("work", "Work"),
                Collection::tasks("todo", "To do"),
            ],
        ));
        let gate = Arc::new(tokio::sync::Notify::new());
        let hold_listing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (answer, held, hold) = (dav.clone(), gate.clone(), hold_listing.clone());
        let harness = serve(move |seen| {
            if seen.target == "/.well-known/caldav" {
                return Reply::status(404);
            }
            let reply = answer.answer(seen);
            if seen.depth.as_deref() == Some("1") && hold.load(Ordering::SeqCst) {
                return Reply::Gated {
                    gate: held.clone(),
                    then: Box::new(reply),
                };
            }
            reply
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
            gate,
            hold_listing,
        }
    }

    async fn open(&self) -> OpenVault {
        let (session, vault) = (self.session.clone(), self.vault.clone());
        tokio::task::spawn_blocking(move || session.open(&vault, OpenSource::Select).unwrap().vault)
            .await
            .unwrap()
    }

    async fn connect(
        &self,
        open: &OpenVault,
        form: &BasicConnection,
        devices: &Devices,
    ) -> Result<String, CaldavError> {
        self.accounts
            .connect(&self.session, open, form, devices)
            .await
    }

    fn password(&self, account: &str) -> Option<Vec<u8>> {
        self.secrets.get(SERVICE, &format!("password-{account}"))
    }
}

fn caldav_sources(open: &OpenVault) -> Vec<CalendarSourceRecord> {
    let mut sources = open
        .vault
        .calendar(with_device_key())
        .unwrap()
        .sources()
        .unwrap()
        .into_iter()
        .filter(|s| s.provider == "caldav")
        .collect::<Vec<_>>();
    sources.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.title.cmp(&b.title)));
    sources
}

fn selected(open: &OpenVault, url: &str) -> Option<bool> {
    caldav_sources(open)
        .into_iter()
        .find(|s| s.remote_id == url)
        .map(|s| s.is_selected)
}

fn choosing(ids: &[&str]) -> BasicConnection {
    BasicConnection {
        selected_calendar_ids: Some(ids.iter().map(|id| (*id).to_owned()).collect()),
        ..form(SERVER)
    }
}

/// Every byte under `dir`, for a search.
fn files_contain(dir: &Path, needle: &[u8]) -> bool {
    std::fs::read_dir(dir).unwrap().flatten().any(|entry| {
        let path = entry.path();
        if path.is_dir() {
            files_contain(&path, needle)
        } else {
            std::fs::read(&path).is_ok_and(|bytes| bytes.windows(needle.len()).any(|w| w == needle))
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_writes_the_rows_and_keeps_the_password_in_this_keychain_only() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let id = rig
        .connect(&open, &form(SERVER), &Devices::signed_out())
        .await
        .unwrap();
    assert_eq!(id, account_id(SERVER, USER));

    let sources = caldav_sources(&open);
    let rows = sources
        .iter()
        .map(|s| (s.kind.as_str(), s.title.as_str(), s.is_selected))
        .collect::<Vec<_>>();
    assert_eq!(rows, [("account", USER, false), ("calendar", "Work", true)]);
    let metadata = sources[0].metadata_json.as_deref().unwrap();
    assert!(metadata.contains("\"serverUrl\":\"https://dav.example/dav/\""));
    assert_eq!(rig.password(&id).as_deref(), Some(PASS.as_bytes()));
    assert!(
        !files_contain(&rig.vault, PASS.as_bytes()),
        "the password never reaches the vault"
    );

    let status = rig.accounts.status(&open, "caldav").await.unwrap();
    assert!(status.connected && status.has_local_auth);
    assert_eq!(status.calendars.total, 1);
    let account = &status.accounts[0];
    assert_eq!(account.status, AccountConnection::Connected);
    assert_eq!(account.server_url.as_deref(), Some(SERVER));
    assert_eq!(account.username.as_deref(), Some(USER));
    assert_eq!(account.preset, Some(None));

    // A device the account synced to, without the password: Reconnect.
    rig.secrets.0.lock().unwrap().clear();
    let status = rig.accounts.status(&open, "caldav").await.unwrap();
    assert!(!status.has_local_auth);
    assert_eq!(
        (
            status.accounts[0].status,
            status.accounts[0].reconnect_reason
        ),
        (
            AccountConnection::ReconnectRequired,
            Some(ReconnectReason::Missing)
        )
    );
    let other = rig.accounts.status(&open, "google").await.unwrap();
    assert!(!other.connected && other.accounts.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_keeps_each_choice_and_archives_a_calendar_the_server_dropped() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let devices = Devices::signed_out();
    rig.connect(&open, &form(SERVER), &devices).await.unwrap();
    assert_eq!(selected(&open, WORK), Some(true));
    rig.connect(&open, &choosing(&[]), &devices).await.unwrap();
    assert_eq!(selected(&open, WORK), Some(false));
    rig.connect(&open, &form(SERVER), &devices).await.unwrap();
    assert_eq!(selected(&open, WORK), Some(false), "a reconnect keeps it");

    rig.dav
        .set_collections(vec![Collection::events("home", "Home")]);
    rig.connect(&open, &form(SERVER), &devices).await.unwrap();
    let titles = caldav_sources(&open)
        .into_iter()
        .map(|s| s.title)
        .collect::<Vec<_>>();
    assert_eq!(titles, [USER, "Home"], "Work is archived");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_archives_the_rows_and_forgets_the_password() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let id = rig
        .connect(&open, &form(SERVER), &Devices::signed_out())
        .await
        .unwrap();
    assert_eq!(rig.accounts.disconnect(&open, None).await.unwrap(), 1);
    assert!(caldav_sources(&open).is_empty());
    assert_eq!(rig.password(&id), None);
    assert_eq!(rig.secrets.len(), 0);
    let status = rig.accounts.status(&open, "caldav").await.unwrap();
    assert!(!status.connected && status.account.is_none());
    // An account id with no rows only loses its password, as in Electron.
    assert_eq!(
        rig.accounts
            .disconnect(&open, Some("caldav-unknown"))
            .await
            .unwrap(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_writer_check_holds_a_connect_until_old_devices_are_acknowledged() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    let old = Devices::of(
        SignIn::SignedIn,
        Some(vec![
            device("this", "macos", Some("2026.900.0"), true),
            device("laptop", "windows", Some("2026.900.0"), false),
            device("phone", "ios", Some("1.0.0"), false),
            device("tower", "linux", Some("2026.925.0"), false),
        ]),
    );
    let compat = writer_compat::check("caldav", &old).await;
    assert!(compat.required && compat.verified);
    let outdated = compat
        .outdated_devices
        .iter()
        .map(|d| d.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        outdated,
        ["laptop"],
        "this device and non-writers are not listed"
    );
    assert!(!writer_compat::check("google", &old).await.required);

    let refused = rig.connect(&open, &form(SERVER), &old).await;
    assert!(matches!(
        refused,
        Err(CaldavError::Connect(ConnectCode::OutdatedDevices))
    ));
    assert!(
        rig.harness.seen().is_empty(),
        "no discovery before the check"
    );
    assert_eq!(rig.secrets.len(), 0);
    assert!(caldav_sources(&open).is_empty());

    for blind in [
        Devices::of(SignIn::Unreadable, Some(Vec::new())),
        Devices::of(SignIn::SignedIn, None),
    ] {
        let refused = rig.connect(&open, &form(SERVER), &blind).await;
        assert!(matches!(
            refused,
            Err(CaldavError::Connect(ConnectCode::OutdatedDevices))
        ));
    }

    let acknowledged = BasicConnection {
        acknowledge_outdated_devices: true,
        ..form(SERVER)
    };
    rig.connect(&open, &acknowledged, &old).await.unwrap();
    assert_eq!(caldav_sources(&open).len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vault_closed_during_discovery_takes_no_write() {
    let rig = Rig::new().await;
    let open = rig.open().await;
    rig.hold_listing.store(true, Ordering::SeqCst);
    let (accounts, session, held) = (rig.accounts.clone(), rig.session.clone(), open.clone());
    let connect = tokio::spawn(async move {
        accounts
            .connect(&session, &held, &form(SERVER), &Devices::signed_out())
            .await
    });
    for _ in 0..2_000 {
        if rig
            .harness
            .seen()
            .iter()
            .any(|s| s.depth.as_deref() == Some("1"))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let session = rig.session.clone();
    tokio::task::spawn_blocking(move || session.close())
        .await
        .unwrap();
    rig.gate.notify_one();
    assert!(matches!(connect.await.unwrap(), Err(CaldavError::Closed)));
    assert_eq!(rig.secrets.len(), 0);
    drop(open);
    let reopened = rig.open().await;
    assert!(caldav_sources(&reopened).is_empty());
}

#[test]
fn the_form_is_held_to_the_schema_bounds() {
    let refuse = |change: fn(&mut BasicConnection)| {
        let mut connection = form(SERVER);
        change(&mut connection);
        matches!(connection.checked(), Err(CaldavError::Invalid(_)))
    };
    assert!(refuse(|c| c.server_url = "   ".to_owned()));
    assert!(refuse(|c| c.username = "u".repeat(321)));
    assert!(refuse(|c| c.password = String::new().into()));
    assert!(refuse(|c| c.password = "p".repeat(1025).into()));
    assert!(refuse(|c| c.preset = Some("p".repeat(65))));
    assert!(refuse(
        |c| c.selected_calendar_ids = Some(vec![WORK.to_owned(); 501])
    ));
    assert!(refuse(
        |c| c.selected_calendar_ids = Some(vec![String::new()])
    ));
    // UTF-16 units, as zod counts: 160 astral characters are 320 units.
    assert!(!refuse(|c| c.username = "\u{1F600}".repeat(160)));
    assert!(refuse(|c| c.username = "\u{1F600}".repeat(161)));
}
