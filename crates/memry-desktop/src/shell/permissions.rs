//! Deny-by-default web permissions: port of `isPermissionAllowed` and `isTrustedAppOrigin`
//! (`apps/desktop/src/main/session-permissions.ts`). The adapters map each engine's permission
//! kind to a [`Permission`] and ask [`allowed`]; one decision serves WebView2 and WebKitGTK.

use url::Url;

/// A permission the page can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// A microphone or camera. `video` is true when the request includes a camera.
    Media {
        audio: bool,
        video: bool,
    },
    ClipboardRead,
    /// Writing to the clipboard from a user gesture (`navigator.clipboard.writeText`).
    ClipboardWrite,
    Notifications,
    /// Geolocation, sensors, MIDI, screen capture, and everything else.
    Other,
}

/// The origins of the app's own pages. `dev_origin` is the dev server (`http://localhost:5173`),
/// `None` in a packaged build. Only that exact origin is trusted, not every loopback address: the
/// loopback media server's embed frames live on `127.0.0.1` too.
pub fn is_trusted_origin(origin: Option<&str>, dev_origin: Option<&str>) -> bool {
    let Some(url) = origin.and_then(|o| Url::parse(o).ok()) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    if let Some(dev) = dev_origin.and_then(|d| Url::parse(d).ok())
        && url.scheme() == dev.scheme()
        && url.host_str() == dev.host_str()
        && url.port_or_known_default() == dev.port_or_known_default()
    {
        return true;
    }
    match url.scheme() {
        "memry-file" => true,
        "tauri" => host == "localhost",
        "https" => matches!(host, "tauri.localhost" | "memry-file.localhost"),
        "http" => host == "tauri.localhost",
        _ => false,
    }
}

/// The voice recorder captures audio only: any camera request is denied. A request that names no
/// device (an enumeration) is allowed for a trusted origin.
pub fn allowed(permission: Permission, origin: Option<&str>, dev_origin: Option<&str>) -> bool {
    if !is_trusted_origin(origin, dev_origin) {
        return false;
    }
    match permission {
        Permission::Media { video, .. } => !video,
        Permission::ClipboardRead | Permission::ClipboardWrite | Permission::Notifications => true,
        Permission::Other => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: Option<&str> = Some("tauri://localhost");
    const DEV: Option<&str> = Some("http://localhost:5173");

    #[test]
    fn trusts_the_app_and_its_file_scheme_origins() {
        for origin in [
            "tauri://localhost",
            "https://tauri.localhost",
            "http://tauri.localhost",
            "memry-file://local",
            "https://memry-file.localhost",
        ] {
            assert!(is_trusted_origin(Some(origin), None), "{origin}");
        }
    }

    #[test]
    fn trusts_the_dev_server_only_in_dev() {
        assert!(is_trusted_origin(Some("http://localhost:5173/x"), DEV));
        assert!(!is_trusted_origin(Some("http://localhost:5173"), None));
        // Not the dev port, not another loopback address.
        for origin in [
            "http://localhost:9999",
            "http://127.0.0.1:5173",
            "https://localhost:5173",
        ] {
            assert!(!is_trusted_origin(Some(origin), DEV), "{origin}");
        }
    }

    #[test]
    fn distrusts_web_embeds_and_the_embed_scheme() {
        for origin in [
            "https://www.youtube-nocookie.com",
            "https://example.com",
            "http://127.0.0.1:41234",
            "memry-html://local",
            "https://memry-html.localhost",
            "https://evil.tauri.localhost.example.com",
            "tauri://evil",
            "not a url",
            "",
        ] {
            assert!(!is_trusted_origin(Some(origin), DEV), "{origin}");
        }
        assert!(!is_trusted_origin(None, DEV));
    }

    #[test]
    fn allows_microphone_clipboard_and_notifications_for_the_app() {
        assert!(allowed(
            Permission::Media {
                audio: true,
                video: false
            },
            APP,
            None
        ));
        assert!(allowed(
            Permission::Media {
                audio: false,
                video: false
            },
            APP,
            None
        ));
        assert!(allowed(Permission::ClipboardRead, APP, None));
        assert!(allowed(Permission::ClipboardWrite, APP, None));
        assert!(allowed(Permission::Notifications, APP, None));
    }

    #[test]
    fn denies_the_camera_even_with_audio_and_everything_else() {
        assert!(!allowed(
            Permission::Media {
                audio: true,
                video: true
            },
            APP,
            None
        ));
        assert!(!allowed(
            Permission::Media {
                audio: false,
                video: true
            },
            APP,
            None
        ));
        assert!(!allowed(Permission::Other, APP, None));
    }

    #[test]
    fn denies_every_permission_to_an_untrusted_origin() {
        let youtube = Some("https://www.youtube-nocookie.com");
        for permission in [
            Permission::Media {
                audio: true,
                video: false,
            },
            Permission::ClipboardRead,
            Permission::ClipboardWrite,
            Permission::Notifications,
        ] {
            assert!(!allowed(permission, youtube, DEV), "{permission:?}");
            assert!(!allowed(permission, None, DEV), "{permission:?}");
        }
    }
}
