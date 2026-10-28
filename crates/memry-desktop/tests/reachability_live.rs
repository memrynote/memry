//! `DesktopReachability` over the real OS watcher, in a network namespace of its own so the test
//! can add and remove the only usable address. Linux only; CI runs the test binary under
//! `sudo unshare -n`, which starts the namespace with nothing but a loopback interface.
//!
//! The network goes away the way a DHCP client or NetworkManager takes it away: the address is
//! removed. An interface whose link drops while it keeps a static IPv4 address still reads as
//! online, because the OS reports no address change (see `seams::reachability`).
#![cfg(target_os = "linux")]

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_desktop::seams::reachability::DesktopReachability;

#[derive(Default)]
struct Heard(Mutex<Vec<Reachable>>);

impl ReachabilityObserver for Heard {
    fn on_change(&self, reachable: Reachable) {
        self.0.lock().unwrap().push(reachable);
    }
}

fn ip(args: &str) {
    let status = Command::new("ip")
        .args(args.split_whitespace())
        .status()
        .expect("the ip command runs");
    assert!(status.success(), "ip {args}");
}

/// Waits up to 5 s for the observer to have heard `expected`, then 3 s more to be sure nothing
/// else follows.
async fn hears(heard: &Heard, expected: &[Reachable]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while heard.0.lock().unwrap().len() < expected.len() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(heard.0.lock().unwrap().as_slice(), expected);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a network namespace of its own: sudo unshare -n <test binary> --ignored"]
async fn an_address_going_and_coming_back_is_one_offline_then_one_wifi() {
    let reachability = DesktopReachability::start(&tokio::runtime::Handle::current());
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        reachability.current(),
        Reachable::Offline,
        "only loopback is up"
    );
    let heard = Arc::new(Heard::default());
    reachability.observe(heard.clone());

    ip("link add memry0 type dummy");
    ip("addr add 10.77.0.2/24 dev memry0");
    ip("link set memry0 up");
    hears(&heard, &[Reachable::Wifi]).await;

    ip("addr flush dev memry0");
    hears(&heard, &[Reachable::Wifi, Reachable::Offline]).await;

    ip("addr add 10.77.0.2/24 dev memry0");
    hears(
        &heard,
        &[Reachable::Wifi, Reachable::Offline, Reachable::Wifi],
    )
    .await;
    assert_eq!(reachability.current(), Reachable::Wifi);
}
