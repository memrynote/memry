use std::sync::Mutex;

use tokio::sync::mpsc;

use super::*;

fn net(text: &str) -> IpNet {
    text.parse().unwrap()
}

#[derive(Default)]
struct Heard(Mutex<Vec<Reachable>>);

impl ReachabilityObserver for Heard {
    fn on_change(&self, reachable: Reachable) {
        self.0.lock().unwrap().push(reachable);
    }
}

impl Heard {
    fn all(&self) -> Vec<Reachable> {
        self.0.lock().unwrap().clone()
    }
}

struct Rig {
    reachability: DesktopReachability,
    events: mpsc::UnboundedSender<io::Result<IfEvent>>,
    heard: Arc<Heard>,
}

impl Rig {
    /// A reachability over a scripted event stream, after the first set `initial` arrived.
    async fn start(initial: &[&str]) -> Self {
        let (events, rx) = mpsc::unbounded_channel();
        let stream = Box::pin(futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|event| (event, rx))
        }));
        let reachability =
            DesktopReachability::with_events(&tokio::runtime::Handle::current(), stream);
        let heard = Arc::new(Heard::default());
        reachability.observe(heard.clone());
        let rig = Self {
            reachability,
            events,
            heard,
        };
        for address in initial {
            rig.send(IfEvent::Up(net(address)));
        }
        rig.settle().await;
        rig
    }

    fn send(&self, event: IfEvent) {
        self.events.send(Ok(event)).unwrap();
    }

    /// Lets the watch task run everything that is ready.
    async fn settle(&self) {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    async fn after(&self, duration: Duration) {
        self.settle().await;
        tokio::time::advance(duration).await;
        self.settle().await;
    }

    fn current(&self) -> Reachable {
        self.reachability.current()
    }
}

#[test]
fn only_an_address_that_can_reach_a_server_counts() {
    let set = |nets: &[&str]| nets.iter().map(|n| net(n)).collect::<HashSet<_>>();
    assert_eq!(classify(&set(&[])), Reachable::Offline);
    assert_eq!(
        classify(&set(&[
            "127.0.0.1/8",
            "::1/128",
            "169.254.3.4/16",
            "fe80::1/64",
            "0.0.0.0/0"
        ])),
        Reachable::Offline
    );
    assert_eq!(
        classify(&set(&["127.0.0.1/8", "192.168.1.4/24"])),
        Reachable::Wifi
    );
    assert_eq!(classify(&set(&["2a02:1::5/64"])), Reachable::Wifi);
}

#[tokio::test(start_paused = true)]
async fn the_first_address_set_applies_at_once() {
    let rig = Rig::start(&["127.0.0.1/8", "192.168.1.4/24"]).await;
    assert_eq!(rig.current(), Reachable::Wifi);
    assert_eq!(rig.heard.all(), [Reachable::Wifi]);

    let offline = Rig::start(&["127.0.0.1/8"]).await;
    assert_eq!(offline.current(), Reachable::Offline);
    assert!(offline.heard.all().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_change_is_reported_once_after_it_held_for_the_debounce() {
    let rig = Rig::start(&["127.0.0.1/8", "192.168.1.4/24"]).await;
    rig.send(IfEvent::Down(net("192.168.1.4/24")));
    rig.after(DEBOUNCE - Duration::from_millis(100)).await;
    assert_eq!(rig.current(), Reachable::Wifi);
    rig.after(Duration::from_millis(100)).await;
    assert_eq!(rig.current(), Reachable::Offline);

    rig.send(IfEvent::Up(net("10.0.0.7/8")));
    rig.after(DEBOUNCE).await;
    assert_eq!(rig.current(), Reachable::Wifi);
    assert_eq!(
        rig.heard.all(),
        [Reachable::Wifi, Reachable::Offline, Reachable::Wifi]
    );
}

#[tokio::test(start_paused = true)]
async fn a_flap_inside_the_debounce_makes_no_callback() {
    let rig = Rig::start(&["192.168.1.4/24"]).await;
    rig.send(IfEvent::Down(net("192.168.1.4/24")));
    rig.after(Duration::from_secs(1)).await;
    rig.send(IfEvent::Up(net("192.168.1.4/24")));
    rig.after(DEBOUNCE * 2).await;
    assert_eq!(rig.current(), Reachable::Wifi);
    assert_eq!(rig.heard.all(), [Reachable::Wifi]);
}

#[tokio::test(start_paused = true)]
async fn more_events_toward_the_same_state_do_not_push_the_report_back() {
    let rig = Rig::start(&["127.0.0.1/8"]).await;
    rig.send(IfEvent::Up(net("192.168.1.4/24")));
    rig.after(Duration::from_millis(1500)).await;
    rig.send(IfEvent::Up(net("2a02:1::5/64")));
    rig.after(Duration::from_millis(500)).await;
    assert_eq!(rig.current(), Reachable::Wifi);
}

#[tokio::test(start_paused = true)]
async fn suspend_is_offline_at_once_and_resume_reads_the_addresses_again() {
    let rig = Rig::start(&["192.168.1.4/24"]).await;
    rig.reachability.on_power_suspend();
    assert_eq!(rig.current(), Reachable::Offline);
    rig.settle().await;
    rig.reachability.on_power_resume();
    rig.settle().await;
    assert_eq!(rig.current(), Reachable::Offline);
    rig.after(DEBOUNCE).await;
    assert_eq!(rig.current(), Reachable::Wifi);
    assert_eq!(
        rig.heard.all(),
        [Reachable::Wifi, Reachable::Offline, Reachable::Wifi]
    );
}

#[tokio::test(start_paused = true)]
async fn a_failed_watcher_leaves_the_state_online() {
    let rig = Rig::start(&["127.0.0.1/8"]).await;
    rig.events
        .send(Err(io::Error::other("netlink closed")))
        .unwrap();
    rig.settle().await;
    assert_eq!(rig.current(), Reachable::Wifi);
    assert_eq!(rig.heard.all(), [Reachable::Wifi]);
}

/// The real OS watcher on this machine: it starts, and it reports its first set.
#[tokio::test(flavor = "multi_thread")]
async fn the_os_watcher_reports_the_machine_s_addresses() {
    let reachability = DesktopReachability::start(&tokio::runtime::Handle::current());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !lock(&reachability.shared.state).settled && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let state = lock(&reachability.shared.state);
    assert!(state.settled, "the watcher reported no address within 5 s");
    assert_eq!(state.reported, classify(&state.addrs));
}
