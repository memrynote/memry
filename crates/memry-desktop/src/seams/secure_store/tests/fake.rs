use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, Entry, Error};

use super::super::{KeyringStore, Store, StoreFactory};

pub type Absent = Arc<Mutex<Option<fn() -> keyring_core::Result<Option<Vec<u8>>>>>>;
pub type BuildError = Arc<Mutex<Option<fn() -> Error>>>;
pub type Data = Arc<Mutex<HashMap<(String, String), Vec<u8>>>>;

/// Blocks `get_secret` until opened.
#[derive(Default)]
pub struct Gate {
    pub open: Mutex<bool>,
    pub changed: Condvar,
    /// Calls that reached the gate: the keychain thread is blocked once this moves.
    pub entered: AtomicUsize,
}

impl Gate {
    pub fn wait(&self) {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }

    /// Returns once `n` calls are blocked at the gate.
    pub fn wait_entered(&self, n: usize) {
        while self.entered.load(Ordering::SeqCst) < n {
            std::thread::yield_now();
        }
    }

    pub fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

#[derive(Clone)]
pub enum Mode {
    Normal,
    Fail(fn() -> Error),
    Block(Arc<Gate>),
    /// Answers after this long, as a keychain that is slow, not stuck.
    Sleep(Duration),
    Panic,
}

/// A credential store with a switch for how its calls behave.
pub struct Fake {
    pub data: Data,
    pub mode: Arc<Mutex<Mode>>,
    pub reads: Arc<AtomicUsize>,
    pub reader_threads: Arc<Mutex<Vec<Option<String>>>>,
    pub targets: Arc<Mutex<Vec<Option<String>>>>,
    /// The (account, `username` attribute) of each `update_attributes`.
    pub usernames: Arc<Mutex<Vec<(String, String)>>>,
    /// Fails every write with this error, while reads and deletes answer.
    pub fail_writes: BuildError,
    pub writes: Arc<AtomicUsize>,
}

pub struct FakeCred {
    pub key: (String, String),
    pub fake: Fake,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            data: Data::default(),
            mode: Arc::new(Mutex::new(Mode::Normal)),
            reads: Arc::default(),
            reader_threads: Arc::default(),
            targets: Arc::default(),
            usernames: Arc::default(),
            fail_writes: Arc::default(),
            writes: Arc::default(),
        }
    }

    pub fn share(&self) -> Self {
        Self {
            data: self.data.clone(),
            mode: self.mode.clone(),
            reads: self.reads.clone(),
            reader_threads: self.reader_threads.clone(),
            targets: self.targets.clone(),
            usernames: self.usernames.clone(),
            fail_writes: self.fail_writes.clone(),
            writes: self.writes.clone(),
        }
    }

    pub fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    pub fn stored(&self, service: &str, account: &str) -> Option<Vec<u8>> {
        self.data
            .lock()
            .unwrap()
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
    }

    pub fn put(&self, service: &str, account: &str, value: &[u8]) {
        self.data
            .lock()
            .unwrap()
            .insert((service.to_owned(), account.to_owned()), value.to_vec());
    }

    pub fn act(&self) -> keyring_core::Result<()> {
        let mode = self.mode.lock().unwrap().clone();
        match mode {
            Mode::Normal => Ok(()),
            Mode::Fail(error) => Err(error()),
            Mode::Block(gate) => {
                gate.wait();
                Ok(())
            }
            Mode::Sleep(pause) => {
                std::thread::sleep(pause);
                Ok(())
            }
            Mode::Panic => panic!("a store that panics"),
        }
    }
}

impl std::fmt::Debug for FakeCred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FakeCred")
    }
}

impl CredentialApi for FakeCred {
    fn set_secret(&self, secret: &[u8]) -> keyring_core::Result<()> {
        self.fake.act()?;
        self.fake.writes.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = *self.fake.fail_writes.lock().unwrap() {
            return Err(error());
        }
        self.fake
            .data
            .lock()
            .unwrap()
            .insert(self.key.clone(), secret.to_vec());
        Ok(())
    }

    fn get_secret(&self) -> keyring_core::Result<Vec<u8>> {
        self.fake.reads.fetch_add(1, Ordering::SeqCst);
        self.fake
            .reader_threads
            .lock()
            .unwrap()
            .push(std::thread::current().name().map(str::to_owned));
        self.fake.act()?;
        self.fake
            .data
            .lock()
            .unwrap()
            .get(&self.key)
            .cloned()
            .ok_or(Error::NoEntry)
    }

    fn delete_credential(&self) -> keyring_core::Result<()> {
        self.fake.act()?;
        match self.fake.data.lock().unwrap().remove(&self.key) {
            Some(_) => Ok(()),
            None => Err(Error::NoEntry),
        }
    }

    fn update_attributes(&self, attributes: &HashMap<&str, &str>) -> keyring_core::Result<()> {
        if let Some(name) = attributes.get("username") {
            self.fake
                .usernames
                .lock()
                .unwrap()
                .push((self.key.1.clone(), (*name).to_owned()));
        }
        Ok(())
    }

    fn get_credential(&self) -> keyring_core::Result<Option<Arc<Credential>>> {
        Ok(None)
    }

    fn get_specifiers(&self) -> Option<(String, String)> {
        Some(self.key.clone())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl std::fmt::Debug for Fake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Fake")
    }
}

impl CredentialStoreApi for Fake {
    fn vendor(&self) -> String {
        "fake".to_owned()
    }

    fn id(&self) -> String {
        "fake".to_owned()
    }

    fn build(
        &self,
        service: &str,
        user: &str,
        modifiers: Option<&HashMap<&str, &str>>,
    ) -> keyring_core::Result<Entry> {
        self.targets.lock().unwrap().push(
            modifiers
                .and_then(|m| m.get("target"))
                .map(|t| (*t).to_owned()),
        );
        Ok(Entry::new_with_credential(Arc::new(FakeCred {
            key: (service.to_owned(), user.to_owned()),
            fake: self.share(),
        })))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Builds the fake, counts builds, and can fail them.
pub struct Factory {
    pub fake: Fake,
    pub builds: Arc<AtomicUsize>,
    pub build_error: BuildError,
    pub names_target: bool,
    /// Items the store does not see but the platform holds: what keytar wrote on Linux.
    pub keytar: Data,
    /// Replaces the keytar lookup of `absent_check` when set.
    pub absent: Absent,
}

impl StoreFactory for Factory {
    fn build(&self) -> keyring_core::Result<Store> {
        self.builds.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = *self.build_error.lock().unwrap() {
            return Err(error());
        }
        Ok(Arc::new(self.fake.share()))
    }

    fn names_target(&self) -> bool {
        self.names_target
    }

    fn absent_check(&self, service: &str, account: &str) -> keyring_core::Result<Option<Vec<u8>>> {
        if let Some(check) = *self.absent.lock().unwrap() {
            return check();
        }
        Ok(self
            .keytar
            .lock()
            .unwrap()
            .get(&(service.to_owned(), account.to_owned()))
            .cloned())
    }

    fn after_set(&self, _: &Entry, service: &str, account: &str) {
        let _ = self.after_delete(service, account);
    }

    fn after_delete(&self, service: &str, account: &str) -> keyring_core::Result<()> {
        self.keytar
            .lock()
            .unwrap()
            .remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

pub struct Rig {
    pub store: Arc<KeyringStore>,
    pub fake: Fake,
    pub builds: Arc<AtomicUsize>,
    pub build_error: BuildError,
    pub keytar: Data,
    pub absent: Absent,
}

pub fn rig_with(suffix: Option<&str>, deadline: Duration, names_target: bool) -> Rig {
    let fake = Fake::new();
    let builds = Arc::new(AtomicUsize::new(0));
    let build_error = Arc::new(Mutex::new(None));
    let keytar = Data::default();
    let absent: Absent = Arc::default();
    let factory = Factory {
        fake: fake.share(),
        builds: builds.clone(),
        build_error: build_error.clone(),
        names_target,
        keytar: keytar.clone(),
        absent: absent.clone(),
    };
    Rig {
        store: Arc::new(KeyringStore::with_factory(
            factory,
            suffix.map(str::to_owned),
            deadline,
        )),
        fake,
        builds,
        build_error,
        keytar,
        absent,
    }
}

pub fn rig() -> Rig {
    rig_with(None, Duration::from_secs(5), false)
}
