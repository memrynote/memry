# Readwise

Connect Readwise to bring the highlights you keep in Readwise into your vault as notes. This works on every plan, free included. It is an integration with your Readwise account, not cloud sync, and it only reads from Readwise: Memry never writes anything back.

::: warning Highlights do not arrive yet
This version connects your account and stores your choices. Importing and syncing the highlights themselves is not available yet, so **Import** and **Sync now** stay disabled for now.
:::

## Connect

Readwise has no sign-in flow for apps, so Memry uses your personal access token.

1. Open **Settings → Import**. **Readwise** sits first, in its own **Reading** group. The row says **Not connected**.
2. Click the row. In the dialog, choose **Get your token** to open `readwise.io/access_token` in your browser, and copy the token.
3. Paste it into **Access token** and click **Connect**.

Memry checks the token with Readwise before it keeps it. A token Readwise does not accept shows an error under the field, and nothing is stored, so you can paste it again.

The token is stored in your system keychain, on this device, for this vault. It never goes into your notes or settings, never syncs to your other devices, and never appears in logs. Connecting is per vault: another vault stays disconnected until you connect it too.

## Choose where notes go

Once connected, the dialog shows your choices.

| Setting           | Default     | What it does                                                                                                                                       |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder**        | `Readwise`  | The vault folder new books land in. It is created the first time a note is written.                                                                |
| **Folder layout** | By category | **By category** sorts notes into `Books`, `Articles`, `Tweets` and `Podcasts` folders. **One folder** puts every note directly in the root folder. |
| **Categories**    | See below   | One switch per category of Readwise item.                                                                                                          |
| **Sync**          | Hourly      | How often new highlights arrive: **Manual**, **Hourly** or **Daily**.                                                                              |

**Books**, **Articles**, **Tweets** and **Podcasts** are on. **Supplementals** is off, because Readwise adds those books by itself and they hold none of your highlights. Turning a category off stops syncing its books and keeps the notes you already have.

Changing the folder or the layout affects new books only. A note never moves after it is created, and a note you moved yourself stays where you put it. If you rename the root folder in Memry, the **Folder** setting follows the rename.

These choices sync to your other devices, so a device that takes over keeps them. The token does not: you paste it again on that device.

## Disconnect

Click **Disconnect** in the dialog. Memry deletes the token from this device and forgets where the last sync stopped. Every note stays, and there is no option to remove them. To connect again, paste a token.

## The row in Settings → Import

Where other sources show a file type, the Readwise row shows the connection: **Not connected**, **Connected**, **Synced 5 minutes ago**, or **Needs attention** when Readwise rejected the token and you need to connect again with a fresh one.
