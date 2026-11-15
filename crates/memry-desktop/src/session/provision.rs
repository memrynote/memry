//! `createDormantVault` (`sync/vault-provisioning.ts:21-64`, main `2466ccc9f0`): a vault for an
//! account vault, made and bound to the server's vault id without becoming the open vault. The
//! caller opens it with [`Session::switch`] once it exists.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use memry_core::api::vault::Vault;
use memry_core::storage::OpenOptions;

use super::{Session, SessionError, lock};
use crate::registry::vaults::{StoredVault, basename, iso_millis};

impl Session {
    /// Creates `folder` (and any missing parent), initialises it as a vault, binds its core to
    /// `server_vault_id` and registers it. The open vault is never closed or repointed. On a
    /// failure, the folders this call created are removed from `.memry` upward while they are
    /// empty, as Electron does: a `.memry` with content keeps the whole vault, so a retry finds it
    /// initialised and complete.
    pub fn provision_dormant(
        &self,
        folder: &Path,
        server_vault_id: &str,
    ) -> Result<(), SessionError> {
        let server_vault_id = server_vault_id.trim();
        if server_vault_id.is_empty() {
            return Err(SessionError::Invalid("the account vault has no id".into()));
        }
        let _queue = lock(&self.inner.lifecycle);
        if let Some(open) = self.current().filter(|open| open.path == folder) {
            open.vault.bind_server_vault(server_vault_id)?;
            return Ok(());
        }
        self.ensure_not_held(folder)?;
        let created = first_missing(folder);
        let provisioned = std::fs::create_dir_all(folder)
            .map_err(|e| {
                SessionError::Invalid(format!("Could not create {}: {e}", folder.display()))
            })
            .and_then(|()| self.provision_in(folder, server_vault_id));
        if let (Err(error), Some(first)) = (&provisioned, created) {
            tracing::warn!(%error, "vault provisioning failed; removing the folders it created");
            remove_created_empty_dirs(folder, &first);
        }
        provisioned
    }

    fn provision_in(&self, folder: &Path, server_vault_id: &str) -> Result<(), SessionError> {
        let core = super::open::prepare_core_dir(folder)?;
        let vault = Vault::open_with(
            core.to_string_lossy().into_owned(),
            OpenOptions {
                verify_integrity: false,
            },
        )?;
        vault.bind_server_vault(server_vault_id)?;
        drop(vault);
        let path = folder.to_string_lossy().into_owned();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        self.inner.registry.upsert(&StoredVault {
            name: basename(&path),
            path,
            note_count: 0,
            task_count: 0,
            last_opened: iso_millis(now),
            is_default: false,
            vault_uuid: Some(server_vault_id.to_owned()),
            account_binding: None,
        })?;
        tracing::info!("provisioned a dormant vault");
        Ok(())
    }
}

/// The topmost ancestor of `folder` (itself included) that does not exist yet: what
/// `create_dir_all` is about to create first. `None` when `folder` exists.
fn first_missing(folder: &Path) -> Option<PathBuf> {
    let mut first = None;
    let mut current = Some(folder);
    while let Some(path) = current {
        match path.try_exists() {
            Ok(false) => first = Some(path.to_path_buf()),
            _ => break,
        }
        current = path.parent();
    }
    first
}

/// Electron's cleanup walk (`vault-provisioning.ts:40-61`): removes `folder/.memry`, then
/// `folder` and its parents up to `first`, the first folder the attempt created, each only while
/// it is empty. Stops at the first one that is not; never removes a file.
fn remove_created_empty_dirs(folder: &Path, first: &Path) {
    let stop = first.parent();
    let memry = folder.join(crate::vault::layout::MEMRY_DIR);
    let mut current = Some(memry.as_path());
    while let Some(dir) = current.filter(|dir| Some(*dir) != stop) {
        match std::fs::remove_dir(dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    kind = ?error.kind(),
                    "an incomplete vault folder was kept after provisioning failed"
                );
                return;
            }
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::*;

    #[test]
    fn provisioning_binds_and_registers_without_touching_the_open_vault() {
        let f = fixture();
        let active = f.vault("active");
        let opened = f.session.open(&active, OpenSource::Select).expect("open");
        put_meta(&opened, "user.note", "keep me");
        let target = f.dir.path().join("parent").join("memry-vault-server-v");

        f.session
            .provision_dormant(&target, "server-vault-uuid")
            .expect("provision");

        let current = f.session.current().expect("still open");
        assert_eq!(current.path, active);
        assert_eq!(meta(&active, "user.note").as_deref(), Some("keep me"));
        assert_eq!(
            meta(&target, "sync.server_vault_id").as_deref(),
            Some("server-vault-uuid")
        );
        let stored = f
            .session
            .registry()
            .get(&target.to_string_lossy())
            .expect("registered");
        assert_eq!(stored.vault_uuid.as_deref(), Some("server-vault-uuid"));
        assert_eq!(
            f.session.registry().current().as_deref(),
            Some(active.to_string_lossy().as_ref())
        );
    }

    /// A failure after the folders exist (here the registry write: `vaults` is not a list) keeps
    /// the open vault and the vault the attempt initialised, whole: a retry finds it initialised
    /// and must still find its `journal` and `attachments` folders. Nothing outside the attempt is
    /// touched.
    #[test]
    fn a_failed_provisioning_keeps_the_active_vault_and_a_retry_finds_a_whole_vault() {
        let f = fixture();
        let active = f.vault("active");
        f.session.open(&active, OpenSource::Select).expect("open");
        let sibling = f.vault("my-notes");
        std::fs::write(sibling.join("keep.md"), "existing vault content").unwrap();
        let set_vaults = |value: serde_json::Value| {
            f.session
                .registry()
                .config()
                .update(|map| {
                    map.insert("vaults".into(), value);
                    Ok::<_, crate::registry::config::ConfigError>(())
                })
                .unwrap();
        };
        set_vaults(serde_json::json!({}));
        let target = f.dir.path().join("new").join("memry-vault-abc");

        let error = f
            .session
            .provision_dormant(&target, "server-vault-uuid")
            .unwrap_err();

        assert!(matches!(error, SessionError::Registry(_)), "{error:?}");
        assert_eq!(f.session.current().expect("open").path, active);
        assert_eq!(
            std::fs::read_to_string(sibling.join("keep.md")).unwrap(),
            "existing vault content"
        );
        assert!(target.join(".memry/core/data.db").is_file());

        set_vaults(serde_json::json!([]));
        f.session
            .provision_dormant(&target, "server-vault-uuid")
            .expect("the retry");
        assert!(target.join("attachments").is_dir());
        assert!(target.join("journal").is_dir());
    }

    #[test]
    fn the_cleanup_removes_an_untouched_attempt_and_keeps_a_started_vault() {
        let dir = tempfile::tempdir().unwrap();
        let attempt = dir.path().join("a").join("vault");
        std::fs::create_dir_all(attempt.join(".memry")).unwrap();
        remove_created_empty_dirs(&attempt, &dir.path().join("a"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        std::fs::create_dir_all(attempt.join(".memry")).unwrap();
        std::fs::create_dir_all(attempt.join("attachments")).unwrap();
        std::fs::write(attempt.join(".memry/config.json"), "{}").unwrap();
        remove_created_empty_dirs(&attempt, &dir.path().join("a"));
        assert!(attempt.join(".memry/config.json").is_file());
        assert!(attempt.join("attachments").is_dir());
    }

    #[test]
    fn an_empty_server_id_creates_nothing() {
        let f = fixture();
        let target = f.dir.path().join("x");
        assert!(f.session.provision_dormant(&target, " ").is_err());
        assert!(!target.exists());
    }
}
