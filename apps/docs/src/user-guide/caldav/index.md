# CalDAV Calendars

CalDAV is the open standard most calendar services speak. Connecting a CalDAV account shows its
calendars in memrynote next to your own events: iCloud (Apple Calendar), Fastmail, Nextcloud,
Radicale, Baïkal, Zoho, Yahoo, mailbox.org, Posteo, Synology, and most self-hosted servers.
It works the same on macOS, Windows and Linux, and does not need a memrynote account.

## Connect an Account

1. Open [Settings → Calendar](/user-guide/settings#calendar) → **CalDAV**.
2. Pick your service. For a server that is not listed, pick **Other CalDAV server**.
3. Enter your username and an **app password** (see your service's page below), then press
   **Test connection**.
4. memrynote finds your calendars and lists them. Untick any you do not want, then press
   **Connect**.

Nothing is saved until the test worked. A wrong password, a wrong address, or an address that is
not a CalDAV server is reported with the reason, and you can fix it and test again.

## Service Pages

- [Apple iCloud](/user-guide/caldav/icloud)
- [Fastmail](/user-guide/caldav/fastmail)
- [Nextcloud](/user-guide/caldav/nextcloud)
- [Radicale and Baïkal (self-hosted)](/user-guide/caldav/self-hosted)
- [Zoho](/user-guide/caldav/zoho)
- [Yahoo](/user-guide/caldav/yahoo)
- [mailbox.org](/user-guide/caldav/mailbox-org)
- [Posteo](/user-guide/caldav/posteo)
- [Synology](/user-guide/caldav/synology)

## Why an App Password

An app password is a separate password your service creates for one app. It lets memrynote read
your calendar without knowing your main password, and you can revoke it on its own. Services that
use two-factor sign-in require one for CalDAV. memrynote stores it in your system's secure
storage on this device only; it never syncs and never reaches memrynote's servers.

## How Often It Updates

CalDAV servers do not notify apps about changes, so memrynote checks each account for changes
every 15 minutes, and straight away when you connect or press **Sync Now**. Only what changed is
downloaded after the first check.

## Other Devices

The account and its events sync to your other memrynote devices, end-to-end encrypted like the
rest of your vault, so they show your CalDAV events without any setup. The app password does not
travel: a device that does not have it shows the account as needing its password. That is not a
sync failure. Enter the app password on that device only if you want it to check the server
itself.

## "Reconnect" on an Account

An account asks you to reconnect when the server stops accepting its password. For iCloud this
almost always means the Apple ID password was reset, which revokes every app-specific password.
Create a new app password and press **Reconnect**. Your calendars, your choices and your events
stay as they were.
