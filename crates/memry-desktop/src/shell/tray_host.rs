//! Whether anything is there to draw the tray icon. On Linux the tray is a StatusNotifierItem:
//! `libayatana-appindicator3` registers one with the `org.kde.StatusNotifierWatcher` of the
//! session and succeeds even when no panel hosts it, so creating the icon proves nothing. A
//! close-to-tray window hidden under such a session has no way back, so the close handler asks
//! here first. Elsewhere the shell always draws the icon.

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::mpsc;
    use std::time::Duration;

    use zbus::blocking::{Connection, Proxy};

    const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    const WATCHER_PATH: &str = "/StatusNotifierWatcher";
    /// A watcher that does not answer is no host: the close must not wait on it.
    const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

    /// True when the session bus has a StatusNotifierWatcher with a host registered.
    pub fn host_registered() -> bool {
        within(PROBE_TIMEOUT, || {
            Connection::session().is_ok_and(|connection| host_registered_on(&connection))
        })
    }

    pub(super) fn host_registered_on(connection: &Connection) -> bool {
        Proxy::new(connection, WATCHER, WATCHER_PATH, WATCHER)
            .and_then(|proxy| proxy.get_property::<bool>("IsStatusNotifierHostRegistered"))
            .unwrap_or(false)
    }

    /// `probe`'s answer, or false when it has not answered within `limit`. A probe stuck on a
    /// wedged bus is left behind on its own thread.
    pub(super) fn within(limit: Duration, probe: impl FnOnce() -> bool + Send + 'static) -> bool {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(probe());
        });
        receiver.recv_timeout(limit).unwrap_or(false)
    }

    #[cfg(test)]
    mod tests {
        use std::os::unix::net::UnixStream;

        use zbus::blocking::connection::Builder;

        use super::*;

        /// A StatusNotifierWatcher that reports `IsStatusNotifierHostRegistered` as the field says.
        struct Watcher(bool);

        #[zbus::interface(name = "org.kde.StatusNotifierWatcher")]
        impl Watcher {
            #[zbus(property)]
            fn is_status_notifier_host_registered(&self) -> bool {
                self.0
            }
        }

        /// A client connected to a server that exports `watcher` (or, with `None`, only an
        /// unrelated object, as a bus with no tray host does), over a socket pair: the real
        /// zbus on both ends, no session bus needed.
        fn client_of(watcher: Option<bool>) -> (Connection, Connection) {
            let (client_end, server_end) = UnixStream::pair().expect("socket pair");
            let guid = zbus::Guid::generate();
            let server = std::thread::spawn(move || {
                let builder = Builder::async_io_unix_stream(server_end)
                    .server(guid)
                    .expect("server")
                    .p2p();
                match watcher {
                    Some(registered) => builder.serve_at(WATCHER_PATH, Watcher(registered)),
                    None => builder.serve_at("/Other", Watcher(false)),
                }
                .expect("serve")
                .build()
                .expect("server connection")
            });
            let client = Builder::async_io_unix_stream(client_end)
                .p2p()
                .build()
                .expect("client connection");
            (client, server.join().expect("server thread"))
        }

        #[test]
        fn a_watcher_with_a_host_registered_is_a_host() {
            let (client, _server) = client_of(Some(true));
            assert!(host_registered_on(&client));
        }

        #[test]
        fn a_watcher_with_no_host_registered_is_not_one() {
            let (client, _server) = client_of(Some(false));
            assert!(!host_registered_on(&client));
        }

        #[test]
        fn a_session_with_no_watcher_has_no_host() {
            let (client, _server) = client_of(None);
            assert!(!host_registered_on(&client));
        }

        #[test]
        fn a_probe_that_does_not_answer_in_time_is_no_host() {
            let answered = within(Duration::from_millis(50), || {
                std::thread::sleep(Duration::from_secs(2));
                true
            });
            assert!(!answered);
        }
    }
}

/// Whether something draws the tray icon. Always true off Linux.
pub fn host_registered() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::host_registered()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
