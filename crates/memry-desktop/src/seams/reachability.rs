//! `DesktopReachability`: online or offline from the OS network events, with Electron's rules
//! (`apps/desktop/src/main/sync/network.ts`).
//!
//! The state is `Wifi` while at least one usable address is up (not loopback, not link-local, not
//! unspecified), else `Offline`; a desktop never reports `Cellular`. `if-watch` delivers the
//! address changes (macOS `SCDynamicStore`, Windows `NotifyIpInterfaceChange`, Linux netlink), so
//! nothing polls. A change is reported once it has held for [`DEBOUNCE`], so a flapping interface
//! makes no callback; the first address set the OS reports at start applies at once.
//!
//! Addresses, not links: a network that goes away by removing its address (Wi-Fi off, a DHCP lease
//! or NetworkManager connection dropped, an adapter disabled on Windows) reads as `Offline`. An
//! interface whose link drops while it keeps a static IPv4 address reads as online, because the OS
//! reports no address change; its requests fail and sync backs off as on any failed request.
//!
//! Step 17 (#3534) calls [`DesktopReachability::on_power_suspend`] and
//! [`DesktopReachability::on_power_resume`] from the power monitor: a suspend reports `Offline` at
//! once, and a resume re-reads the addresses, as `network.ts` does.

use std::collections::HashSet;
use std::io;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures_util::{FutureExt as _, Stream, StreamExt as _};
use if_watch::{IfEvent, IpNet};
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Electron's `DEFAULT_DEBOUNCE_MS`.
pub const DEBOUNCE: Duration = Duration::from_secs(2);

/// An address a request to the sync server could leave from.
fn usable(net: &IpNet) -> bool {
    match net.addr() {
        IpAddr::V4(ip) => !(ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()),
        IpAddr::V6(ip) => !(ip.is_loopback() || ip.is_unspecified() || ip.is_unicast_link_local()),
    }
}

fn classify(addrs: &HashSet<IpNet>) -> Reachable {
    if addrs.iter().any(usable) {
        Reachable::Wifi
    } else {
        Reachable::Offline
    }
}

struct State {
    addrs: HashSet<IpNet>,
    reported: Reachable,
    /// A change waiting out the debounce: the state it would report, and when.
    pending: Option<(Reachable, Instant)>,
    /// The OS has reported its first address set.
    settled: bool,
}

struct Shared {
    state: Mutex<State>,
    observers: Mutex<Vec<Arc<dyn ReachabilityObserver>>>,
    /// Held while observers are told, so they hear the changes in the order they happened.
    delivery: Mutex<()>,
    /// Wakes the watch task when `pending` changed outside it.
    wake: Notify,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    /// Changes the state under `change` and tells the observers when the reported state moved.
    /// An observer must not call back into `on_power_suspend` or `on_power_resume`.
    fn transition(&self, change: impl FnOnce(&mut State, Instant) -> Option<Reachable>) {
        let delivery = lock(&self.delivery);
        let moved = {
            let mut state = lock(&self.state);
            change(&mut state, Instant::now())
                .filter(|to| *to != state.reported)
                .inspect(|to| state.reported = *to)
        };
        if let Some(to) = moved {
            tracing::info!(scope = "Reachability", "network is {to:?}");
            let observers = lock(&self.observers).clone();
            for observer in observers {
                observer.on_change(to);
            }
        }
        drop(delivery);
    }

    /// Re-reads the address set: a change starts (or keeps) its debounce, and a return to the
    /// reported state cancels it. The first set the OS reports applies at once.
    fn recompute(&self) {
        self.transition(|state, now| {
            let current = classify(&state.addrs);
            if !state.settled {
                state.settled = true;
                state.pending = None;
                return Some(current);
            }
            if current == state.reported {
                state.pending = None;
            } else if state.pending.is_none_or(|(target, _)| target != current) {
                state.pending = Some((current, now + DEBOUNCE));
            }
            None
        });
    }

    /// The debounce ran out: the state the addresses give now is reported.
    fn fire(&self) {
        self.transition(|state, now| {
            let (_, at) = state.pending?;
            if at > now {
                return None;
            }
            state.pending = None;
            Some(classify(&state.addrs))
        });
    }

    fn apply(&self, event: IfEvent) {
        let mut state = lock(&self.state);
        match event {
            IfEvent::Up(net) => state.addrs.insert(net),
            IfEvent::Down(net) => state.addrs.remove(&net),
        };
    }

    /// The watcher failed: requests decide from here on, so the state stays online and sync keeps
    /// trying (a failed request is its own offline signal).
    fn give_up(&self, error: &io::Error) {
        tracing::error!(
            scope = "Reachability",
            "network changes can no longer be watched; reporting online from now on: {error}"
        );
        self.transition(|state, _| {
            state.pending = None;
            state.settled = true;
            Some(Reachable::Wifi)
        });
    }
}

pub struct DesktopReachability {
    shared: Arc<Shared>,
    task: Option<JoinHandle<()>>,
}

impl DesktopReachability {
    /// Watches the OS network events on `runtime` until dropped.
    pub fn start(runtime: &tokio::runtime::Handle) -> Self {
        let watcher = {
            let _entered = runtime.enter();
            if_watch::tokio::IfWatcher::new()
        };
        match watcher {
            Ok(watcher) => Self::with_events(runtime, watcher),
            Err(error) => {
                let reachability = Self::with_events(runtime, futures_util::stream::pending());
                reachability.shared.give_up(&error);
                reachability
            }
        }
    }

    /// The same over any stream of address events, for tests.
    #[doc(hidden)]
    pub fn with_events<S>(runtime: &tokio::runtime::Handle, events: S) -> Self
    where
        S: Stream<Item = io::Result<IfEvent>> + Unpin + Send + 'static,
    {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                addrs: HashSet::new(),
                reported: Reachable::Offline,
                pending: None,
                settled: false,
            }),
            observers: Mutex::new(Vec::new()),
            delivery: Mutex::new(()),
            wake: Notify::new(),
        });
        let task = runtime.spawn(watch(shared.clone(), events));
        Self {
            shared,
            task: Some(task),
        }
    }

    /// The machine is going to sleep: offline now, as `network.ts` does.
    pub fn on_power_suspend(&self) {
        self.shared.transition(|state, _| {
            state.pending = None;
            Some(Reachable::Offline)
        });
        self.shared.wake.notify_one();
    }

    /// The machine woke: the addresses are read again now rather than at the next OS event.
    pub fn on_power_resume(&self) {
        self.shared.recompute();
        self.shared.wake.notify_one();
    }
}

impl Drop for DesktopReachability {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Reachability for DesktopReachability {
    fn current(&self) -> Reachable {
        lock(&self.shared.state).reported
    }

    fn observe(&self, observer: Arc<dyn ReachabilityObserver>) {
        lock(&self.shared.observers).push(observer);
    }
}

async fn watch<S>(shared: Arc<Shared>, mut events: S)
where
    S: Stream<Item = io::Result<IfEvent>> + Unpin,
{
    loop {
        let deadline = lock(&shared.state).pending.map(|(_, at)| at);
        let sleep = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            event = events.next() => {
                let mut next = event;
                // Everything the stream has ready is one change: the first set at start, or the
                // several addresses of one interface.
                loop {
                    match next {
                        Some(Ok(event)) => shared.apply(event),
                        Some(Err(error)) => return shared.give_up(&error),
                        None => {
                            return shared.give_up(&io::Error::other("the watcher stopped"));
                        }
                    }
                    match events.next().now_or_never() {
                        Some(more) => next = more,
                        None => break,
                    }
                }
                shared.recompute();
            }
            () = sleep => shared.fire(),
            () = shared.wake.notified() => {}
        }
    }
}

#[cfg(test)]
#[path = "reachability_tests.rs"]
mod tests;
