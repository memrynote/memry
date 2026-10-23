# Readwise

Connect Readwise to bring the highlights you keep in Readwise into your vault as notes. This works on every plan, free included. It is an integration with your Readwise account, not cloud sync, and it only reads from Readwise: Memry never writes anything back.

Once you have imported, Memry checks Readwise for you: on launch and then every hour by default. See [Automatic syncing](#automatic-syncing).

## Connect

Readwise has no sign-in flow for apps, so Memry uses your personal access token.

1. Open **Settings → Import**. **Readwise** sits first, in its own **Reading** group. The row says **Not connected**.
2. Click the row. In the dialog, choose **Get your token** to open `readwise.io/access_token` in your browser, and copy the token.
3. Paste it into **Access token** and click **Connect**.

Memry checks the token with Readwise before it keeps it. A token Readwise does not accept shows an error under the field, and nothing is stored, so you can paste it again.

The token is stored in your system keychain, on this device, for this vault. It never goes into your notes or settings, never syncs to your other devices, and never appears in logs. Connecting is per vault: another vault stays disconnected until you connect it too.

## Review and import

The first time you open the dialog after connecting, Memry reads your Readwise library and shows what it holds. Nothing is written yet.

- Each category has a tile with the number of books in it and a switch. **Books**, **Articles**, **Tweets** and **Podcasts** are on. **Supplementals** is off, because Readwise adds those books by itself and they hold none of your highlights. A tile reads **will import** or **off**. An **Other** tile appears if Readwise returns a category Memry does not know. Those books are always imported.
- The intro line gives the totals, such as _2,184 highlights across 545 books are ready_, and how many books will import with your switches.
- Below the tiles, choose the **Folder** and the **Folder layout**.

The **Import** button names what it will do, such as **Import 505 books**. Press it to start. The dialog shows progress as books are written, and **Cancel** stops the run after the book in progress. Books already written stay, and you can start the import again. When it finishes, the dialog lists how many books were imported, which were skipped and why, and which failed.

If your Readwise library has no highlights yet, the preview says so, and **Import** still completes the setup.

### What lands in your vault

Each book, article, tweet or podcast becomes one note, named after its title. If a note with that name exists, Memry adds its usual number suffix, as in `Deep Work 1`. The note holds the Readwise section: the cover, then your document note and summary if there are any, then the highlights in the order they appear in the book, each with a link back to Readwise and its date. The author, source, category, link to Readwise and book tags are written as properties once, when the note is created. Images are downloaded into your vault, so the note works offline. Folder names, headings and labels in these notes are in English, whatever language the app uses.

Highlight text is quoted as plain text. A `#tag` or `[[link]]` in a highlight does not turn into a Memry tag or link.

### Importing again

Press **Sync now** again at any time, or let Memry do it on its schedule. After the first import, Memry asks Readwise only for what changed since the last run, and writes only the books that changed:

- **New highlights** arrive in the note. In a section you have not edited, they sit in the order they appear in the book. In a section you edited, they are added at the end, and your edits stay.
- **Edits and deletions in Readwise** reach a section you have not edited. In a section you edited, Readwise edits of older highlights do not arrive, and a highlight you deleted from the note stays deleted.
- **A new book** becomes a new note. **A note you deleted** stays deleted, and Memry does not bring the book back. **A book you deleted in Readwise** keeps its note, and Memry stops updating it.
- **A note that is open in the editor** is skipped and written on the next import after you close it.
- **A book that fails to write**, such as one whose folder is read-only, is reported in the summary and fetched again on the next import. It never stops the rest of the run.
- **Turning a category on** brings in all of its books on the next import. Turning one off leaves its notes as they are.
- **A change to the whole book** with no highlight change, such as a new document note, can take up to a day to reach the note, because Memry reads your whole library once a day to catch those.

If the import stops halfway, for example when you quit the app, the next import covers the same changes again. Nothing is skipped or written twice.

A run that changes nothing writes nothing. A run that changes something adds one line to the vault activity list in **Settings**, such as _Readwise: 3 books, 12 highlights_. Your own text above, below and inside the section is never overwritten.

## Automatic syncing

After your first import, Memry syncs without being asked.

- **On launch.** When you open Memry with Readwise connected and **Sync** set to **Hourly** or **Daily**, it runs one sync a moment after the vault opens.
- **On a schedule.** **Hourly** syncs about once an hour while Memry is open, and **Daily** once a day. **Manual** never syncs by itself: nothing runs until you press **Sync now**. Your choice is saved, so it holds after a restart and on your other devices.
- **Sync now.** The button in the Readwise dialog runs a sync right away and shows when it is done. If a sync is already running, it waits for that one instead of starting a second. It cannot join an import you started from the same dialog; wait for that one to finish.
- **Only with a token.** Memry never syncs a disconnected vault, and never starts your first import by itself: that one always waits for you, so you see the preview first.
- **Offline.** Memry skips a scheduled sync while the computer is offline and tries again on the next minute once it is back. A sync that fails because Readwise or the network is unavailable is retried after 5 minutes, then 10, 20 and so on, up to 6 hours between attempts. A sync that fails halfway writes what it finished, and the next one picks up from there.
- **A token Readwise rejects.** Memry stops the schedule instead of trying again every hour. The row shows **Needs attention** until you connect again with a fresh token. Connecting resumes the schedule.

## Fix one book

Three cases that importing cannot fix on its own each have a command. They appear on a note that came from Readwise, and they write into the note even while it is open, because you asked for the change.

- **Re-import from Readwise** rewrites the Readwise section from scratch. Use it after you edited the section and want Readwise's version back. It asks first, because text you wrote inside the section is lost. Text above and below the section and the note's properties stay. Afterwards the section counts as unedited again, so new highlights, edits and deletions from Readwise reach it as before.
- **Refresh book info** writes the author, category, source and source link from Readwise into the note's properties. For an article it also saves the cover image. Readwise tags the note lacks are added. No tag is removed, so a tag you added stays, and a tag Readwise dropped stays too. The note keeps its title and its place in the vault. A field Readwise has no value for is left as it is. This is the only time Memry changes the properties after the note is created.
- **Restore** brings back a note you deleted. Open the Readwise dialog and find **Deleted books**: each row has the book's title, the day you deleted the note and its highlight count. **Restore** creates the note again with all of its highlights. If a note for that book already exists, Memry links to it and does not make a second one.

Find **Re-import from Readwise** and **Refresh book info** in the note's more menu (the three dots), under **Readwise**, and in the command palette.

These commands need your token, so they run on the device that syncs with Readwise. On another device the two note commands are disabled and say that Readwise syncs on the other device, and **Deleted books** shows the same line. The list of deleted books lives on the syncing device too, so it starts empty when another device takes over.

## Choose where notes go

Once you have imported, the dialog shows your choices.

| Setting           | Default     | What it does                                                                                                                                       |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder**        | `Readwise`  | The vault folder new books land in. It is created the first time a note is written.                                                                |
| **Folder layout** | By category | **By category** sorts notes into `Books`, `Articles`, `Tweets` and `Podcasts` folders. **One folder** puts every note directly in the root folder. |
| **Categories**    | See below   | One switch per category of Readwise item.                                                                                                          |
| **Sync**          | Hourly      | How often Memry checks Readwise for new highlights: **Manual**, **Hourly** or **Daily**.                                                           |

Turning a category off keeps the notes you already have and skips its books on the next import. Notes of an unknown category go into an `Other` folder.

Changing the folder or the layout affects new books only. A note never moves after it is created, and a note you moved yourself stays where you put it. If you rename the root folder in Memry, the **Folder** setting follows the rename.

These choices sync to your other devices, so a device that takes over keeps them. The token does not: you paste it again on that device.

## Disconnect

Click **Disconnect** in the dialog. Memry deletes the token from this device and forgets where the last sync stopped. Every note stays, and there is no option to remove them. To connect again, paste a token.

## The row in Settings → Import

Where other sources show a file type, the Readwise row shows the connection: **Not connected**, **Connected**, **Synced 5 minutes ago**, or **Needs attention** when Readwise rejected the token and you need to connect again with a fresh one.
