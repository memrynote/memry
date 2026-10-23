# Readwise

Connect Readwise to bring the highlights you keep in Readwise into your vault as notes. This works on every plan, free included. It is an integration with your Readwise account, not cloud sync, and it only reads from Readwise: Memry never writes anything back.

::: warning Syncing is manual for now
**Import now** brings in everything new since the last time, but it only runs when you press it. Memry does not check Readwise by itself yet, and **Sync now** stays disabled until it does.
:::

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

Press **Import now** again at any time. After the first import, Memry asks Readwise only for what changed since the last run, and writes only the books that changed:

- **New highlights** arrive in the note. In a section you have not edited, they sit in the order they appear in the book. In a section you edited, they are added at the end, and your edits stay.
- **Edits and deletions in Readwise** reach a section you have not edited. In a section you edited, Readwise edits of older highlights do not arrive, and a highlight you deleted from the note stays deleted.
- **A new book** becomes a new note. **A note you deleted** stays deleted, and Memry does not bring the book back. **A book you deleted in Readwise** keeps its note, and Memry stops updating it.
- **A note that is open in the editor** is skipped and written on the next import after you close it.
- **A book that fails to write**, such as one whose folder is read-only, is reported in the summary and fetched again on the next import. It never stops the rest of the run.
- **Turning a category on** brings in all of its books on the next import. Turning one off leaves its notes as they are.
- **A change to the whole book** with no highlight change, such as a new document note, can take up to a day to reach the note, because Memry reads your whole library once a day to catch those.

If the import stops halfway, for example when you quit the app, the next import covers the same changes again. Nothing is skipped or written twice.

A run that changes nothing writes nothing. A run that changes something adds one line to the vault activity list in **Settings**, such as _Readwise: 3 books, 12 highlights_. Your own text above, below and inside the section is never overwritten.

## Choose where notes go

Once you have imported, the dialog shows your choices.

| Setting           | Default     | What it does                                                                                                                                       |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder**        | `Readwise`  | The vault folder new books land in. It is created the first time a note is written.                                                                |
| **Folder layout** | By category | **By category** sorts notes into `Books`, `Articles`, `Tweets` and `Podcasts` folders. **One folder** puts every note directly in the root folder. |
| **Categories**    | See below   | One switch per category of Readwise item.                                                                                                          |
| **Sync**          | Hourly      | How often new highlights will arrive: **Manual**, **Hourly** or **Daily**.                                                                         |

Turning a category off keeps the notes you already have and skips its books on the next import. Notes of an unknown category go into an `Other` folder.

Changing the folder or the layout affects new books only. A note never moves after it is created, and a note you moved yourself stays where you put it. If you rename the root folder in Memry, the **Folder** setting follows the rename.

These choices sync to your other devices, so a device that takes over keeps them. The token does not: you paste it again on that device.

## Disconnect

Click **Disconnect** in the dialog. Memry deletes the token from this device and forgets where the last sync stopped. Every note stays, and there is no option to remove them. To connect again, paste a token.

## The row in Settings → Import

Where other sources show a file type, the Readwise row shows the connection: **Not connected**, **Connected**, **Synced 5 minutes ago**, or **Needs attention** when Readwise rejected the token and you need to connect again with a fresh one.
