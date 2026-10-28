//! The e2e build's credential store: one JSON file under the e2e data dir, so a test that
//! restarts the app on the same profile finds its keys again. Debug builds only (see the
//! `compile_error!` in `mod.rs`); the file holds secrets in the clear.

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, Entry, Error};

use super::{Store, StoreFactory};

const FILE: &str = "e2e-secure-store.json";

/// `"<service>\0<account>"` to the secret bytes.
type Items = BTreeMap<String, Vec<u8>>;

/// The file and the lock that serializes read-modify-write of it within the process.
#[derive(Debug, Clone)]
struct Files {
    path: PathBuf,
    gate: Arc<Mutex<()>>,
}

impl Files {
    fn read(&self) -> keyring_core::Result<Items> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| Error::BadStoreFormat("the e2e secret file is malformed".to_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Items::new()),
            Err(error) => Err(Error::PlatformFailure(Box::new(error))),
        }
    }

    fn write(&self, items: &Items) -> keyring_core::Result<()> {
        let fail = |error: std::io::Error| Error::PlatformFailure(Box::new(error));
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(fail)?;
        }
        let json = serde_json::to_vec(items).map_err(|e| Error::PlatformFailure(Box::new(e)))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(fail)?;
        std::fs::rename(&tmp, &self.path).map_err(fail)
    }

    fn change<T>(
        &self,
        change: impl FnOnce(&mut Items) -> keyring_core::Result<T>,
    ) -> keyring_core::Result<T> {
        let _held = self.gate.lock().unwrap_or_else(PoisonError::into_inner);
        let mut items = self.read()?;
        let before = items.clone();
        let out = change(&mut items)?;
        if items != before {
            self.write(&items)?;
        }
        Ok(out)
    }
}

#[derive(Debug)]
pub struct FileStore(Files);

impl FileStore {
    pub fn new(dir: &Path) -> Self {
        Self(Files {
            path: dir.join(FILE),
            gate: Arc::default(),
        })
    }
}

impl StoreFactory for FileStore {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(Arc::new(Self(self.0.clone())))
    }
}

#[derive(Debug)]
struct FileCred {
    files: Files,
    key: String,
}

impl CredentialApi for FileCred {
    fn set_secret(&self, secret: &[u8]) -> keyring_core::Result<()> {
        self.files.change(|items| {
            items.insert(self.key.clone(), secret.to_vec());
            Ok(())
        })
    }

    fn get_secret(&self) -> keyring_core::Result<Vec<u8>> {
        self.files
            .change(|items| items.get(&self.key).cloned().ok_or(Error::NoEntry))
    }

    fn delete_credential(&self) -> keyring_core::Result<()> {
        self.files
            .change(|items| items.remove(&self.key).map(|_| ()).ok_or(Error::NoEntry))
    }

    fn get_credential(&self) -> keyring_core::Result<Option<Arc<Credential>>> {
        Ok(None)
    }

    fn get_specifiers(&self) -> Option<(String, String)> {
        let (service, account) = self.key.split_once('\0')?;
        Some((service.to_owned(), account.to_owned()))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl CredentialStoreApi for FileStore {
    fn vendor(&self) -> String {
        "memry e2e file store".to_owned()
    }

    fn id(&self) -> String {
        "memry-e2e-file".to_owned()
    }

    fn build(
        &self,
        service: &str,
        user: &str,
        _modifiers: Option<&HashMap<&str, &str>>,
    ) -> keyring_core::Result<Entry> {
        Ok(Entry::new_with_credential(Arc::new(FileCred {
            files: self.0.clone(),
            key: format!("{service}\0{user}"),
        })))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn debug_fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(self, f)
    }
}
