//! A failed or cut-off run and its rerun (REVIEW-5140 #1): no vault installs until every vault
//! passed, and a rerun reads what the previous app wrote in between.

use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::*;

fn electron_db(w: &World, name: &str) -> PathBuf {
    Path::new(&w.vault(name)).join(".memry").join("data.db")
}

/// A row the previous app writes, in a table Step 36 imports.
fn add_tag(data_db: &Path) {
    let conn = Connection::open(data_db).unwrap();
    electron_db::seed(&conn, "tag_definitions", &[]);
}

fn core_tags(w: &World, name: &str) -> i64 {
    Connection::open(w.core_data(name))
        .unwrap()
        .query_row("SELECT count(*) FROM tag_definitions", [], |row| row.get(0))
        .unwrap()
}

/// Home holds a row Step 36 cannot import yet: the run stops at `NotReady` on it.
fn block(w: &World, name: &str, blocked: bool) {
    let conn = Connection::open(electron_db(w, name)).unwrap();
    if blocked {
        electron_db::seed(&conn, "attachment_files", &[]);
    } else {
        conn.execute("DELETE FROM attachment_files", []).unwrap();
    }
}

/// Red with an install per vault as it is staged: Work, planned before Home, is installed when
/// Home fails, and the rerun keeps that stale core.
#[test]
fn a_failed_run_installs_no_vault_and_the_rerun_reads_what_electron_wrote_since() {
    let w = two_vault_world();
    block(&w, "Home", true);

    let error = w.run().unwrap_err();

    assert_eq!(error.check(), "not-ready", "{error}");
    assert!(!w.core_data("Work").exists(), "Work is not installed");
    assert!(!w.core_data("Home").exists());
    assert!(w.marker().is_none());

    add_tag(&electron_db(&w, "Work"));
    block(&w, "Home", false);
    w.run().unwrap();

    assert_eq!(w.status("Work"), VaultStatus::Imported);
    assert_eq!(
        core_tags(&w, "Work"),
        1,
        "the row Electron wrote after the failure"
    );
    assert_eq!(w.marker_fingerprint("Work"), Some(w.fingerprint("Work")));
}

struct EditAtFinish {
    data_db: PathBuf,
    edited: AtomicBool,
}

impl ProgressSink for EditAtFinish {
    fn update(&self, update: ProgressUpdate) {
        if update.phase == Phase::Finish && !self.edited.swap(true, Ordering::SeqCst) {
            add_tag(&self.data_db);
        }
    }
}

/// Red with the fingerprint taken when the marker is written: an Electron write after the
/// install then matches the marker, and the downgrade notice (37f) never shows.
#[test]
fn the_marker_holds_the_fingerprint_the_import_read() {
    let w = two_vault_world();
    let read = w.fingerprint("Work");
    let sink = EditAtFinish {
        data_db: electron_db(&w, "Work"),
        edited: AtomicBool::new(false),
    };
    let mut ctx = w.ctx(None);
    ctx.progress = &sink;

    w.run_with(&ctx).unwrap();

    assert!(sink.edited.load(Ordering::SeqCst));
    assert_ne!(
        w.fingerprint("Work"),
        read,
        "Electron wrote after the install"
    );
    assert_eq!(w.marker_fingerprint("Work"), Some(read));
}

/// Red with an installed vault kept on a rerun whatever its fingerprint: the rows Electron
/// wrote after the install never arrive.
#[test]
fn a_rerun_imports_again_a_vault_electron_wrote_after_its_install() {
    let w = two_vault_world();
    let crashed = catch_unwind(AssertUnwindSafe(|| w.run_with(&w.ctx(Some("vault")))));
    assert!(crashed.is_err());
    assert!(w.core_data("Work").is_file(), "installed before the crash");
    assert_eq!(core_tags(&w, "Work"), 0);

    add_tag(&electron_db(&w, "Work"));
    w.run().unwrap();

    assert_eq!(core_tags(&w, "Work"), 1);
    assert_eq!(w.status("Work"), VaultStatus::Imported);
    assert_eq!(w.marker_fingerprint("Work"), Some(w.fingerprint("Work")));
}

/// Linux `v10`: the fixed key, so no key source is asked.
fn v10(plain: &str) -> String {
    use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
    let mut key = [0_u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1, &mut key);
    let body = cbc::Encryptor::<aes::Aes128>::new((&key).into(), (&[0x20_u8; 16]).into())
        .encrypt_padded_vec::<Pkcs7>(plain.as_bytes());
    STANDARD.encode([b"v10".as_slice(), &body].concat())
}

/// Electron's safeStorage file holding `token` as the sync access token.
fn electron_access_token(w: &World, token: &str) {
    let store = json!({"version": 1, "entries": {
        "com.memry.sync": { "access-token": v10(&STANDARD.encode(token)) },
    }});
    fs::write(
        w.profile.join("secure-secrets.json"),
        serde_json::to_vec(&store).unwrap(),
    )
    .unwrap();
}

fn electron_spell_check(w: &World, on: bool) {
    let path = w.profile.join("memry-config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["spellCheck"] = json!(on);
    w.write_config(&config);
}

/// Red with the app-state and secrets sections of the failed run reused: the rerun keeps the
/// config and the token Electron had before the user went back to it (Q3).
#[test]
fn a_rerun_after_a_failure_copies_the_config_and_secrets_electron_has_now() {
    let w = two_vault_world();
    electron_access_token(&w, "token-1");
    block(&w, "Home", true);
    let mut ctx = w.ctx(None);
    ctx.env.host = HostOs::Linux;
    let token = || w.rig.store.get(SecureStoreKey::AccessToken).unwrap();

    w.run_with(&ctx).unwrap_err();
    assert_eq!(token(), Some(b"token-1".to_vec()));
    assert_eq!(w.spell_check(), Some(json!(true)));

    electron_access_token(&w, "token-2");
    electron_spell_check(&w, false);
    block(&w, "Home", false);
    w.run_with(&ctx).unwrap();

    assert_eq!(token(), Some(b"token-2".to_vec()));
    assert_eq!(w.spell_check(), Some(json!(false)));
}
