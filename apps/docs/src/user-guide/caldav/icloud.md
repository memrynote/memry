# Apple iCloud (CalDAV)

iCloud Calendar, the calendar behind Apple Calendar on iPhone, iPad and Mac, connects over CalDAV.
This works on Windows and Linux as well as macOS.

## Create an App-Specific Password

iCloud does not accept your Apple ID password in other apps. It needs an app-specific password,
which requires two-factor authentication on your Apple ID.

1. Sign in at [account.apple.com](https://account.apple.com).
2. Go to **Sign-In and Security** → **App-Specific Passwords**.
3. Create a password, name it "memrynote", and copy it.

## Connect

In [Settings → Calendar](/user-guide/settings#calendar) → **CalDAV**, pick **Apple iCloud**,
enter your Apple ID email and the app-specific password, and press **Test connection**.

If iCloud rejects the password, memrynote says so and reminds you that the Apple ID password does
not work here. That is the most common cause.

## When It Stops Syncing

Resetting your Apple ID password revokes every app-specific password. The account then shows
**Reconnect** with that explanation. Create a new app-specific password and reconnect.
