# Radicale and Baïkal (Self-Hosted CalDAV)

Self-hosted servers use the address you gave them, including addresses on your home network.

## Connect

In [Settings → Calendar](/user-guide/settings#calendar) → **CalDAV**, pick
**Radicale or Baïkal (self-hosted)** and type the server's address:

- Radicale: the address it listens on, such as `http://192.168.1.5:5232/`.
- Baïkal: the DAV address, such as `https://dav.example.com/dav.php/`.

Enter the username and password the server knows you by, and press **Test connection**.

memrynote sends your password only to the server you typed. A plain `http://` address works for a
server on your own network; over the internet, use `https://`.

Servers that only allow Digest sign-in are supported as well.
