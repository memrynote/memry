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
- **List each day's highlights in the journal** is a switch below the tiles, off by default. The first import writes nothing to the journal whether it is on or off. See [The day's highlights in your journal](#the-day-s-highlights-in-your-journal).
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

## Readwise Reader

Readwise Reader is the read-it-later app. Your Reader highlights already come through the steps above, because Readwise stores them like any other highlight. Memry joins the two: a Reader document that has highlights is one note, and its highlights sit in that note's section. The note lands in the `Articles` folder, or the folder of its category.

A Reader library can also hold thousands of saved documents you never highlighted. Those stay out of your vault unless you ask. In **Readwise Reader**, in the dialog's settings, there are two switches, both off:

- **Also import saved Reader documents.** Documents in **New**, **Later**, **Shortlist** and **Archive** that have no highlights become notes in the `Reader` folder, inside your Readwise folder. **Feed** items, such as RSS and newsletters you never saved, are never read. The first-import preview shows a **Saved Reader documents** tile with a switch. With the switch on, the tile shows how many documents will import, and the **Import** button counts them as notes. Reading a large library takes a few minutes, because Reader allows 20 requests a minute.
- **Include full article text.** The article text is written once, below the Readwise section, when the note is created. After that it is yours: Memry never changes it, and a note that exists when you turn this on does not change. Images inside the text are left out; the cover image is saved as usual.

What a Reader note holds, once, when it is created: the author, site name, publication date, word count, source link, link to Reader and the tags. An article's image becomes its cover, and another document's image sits at the top of the section. Where the document is in Reader (**New** or **Archive**) and how far you have read are not saved, because they change while you read.

- **One note per document.** If you highlight a saved document later, its note stays in `Reader` and the highlights are added to the section there. Memry never moves a note and never makes a second one.
- **Turning the switch off** stops new Reader notes. It deletes none, and it makes no request to Reader.
- **A document you delete in Reader** keeps its note. **A note you delete** stays deleted.
- Memry only reads from Reader. Nothing is changed in your Readwise account.

## The day's highlights in your journal

A reading log, if you want one. With **List each day's highlights in the journal** on, the journal entry of each day you highlighted gets a Readwise section that lists the books and how many highlights you made in each, linked to the book notes:

```markdown
<!-- readwise-day:start -->

### Readwise

- [[Deep Work]]: 3 highlights
- [[How to Take Smart Notes]]: 1 highlight

<!-- readwise-day:end v1 hash=4b1e09aa -->
```

The book notes then show those days as backlinks. The switch is in the dialog's settings, under **Journal**, and in the first-import preview. It is off by default, because it writes into your journal, which you write yourself. It syncs to your other devices like the other Readwise settings. Nothing is written while the **Journal** feature is off in Settings → Features.

- **New highlights only.** Memry does not fill in the past. The first import, a new device taking over Readwise, and turning a category on write nothing to the journal. Only highlights that arrive in a later sync, while the switch is on, count. A highlight that arrives late goes into the day you made it: a Kindle that syncs on Friday adds to Tuesday's entry, and creates the entry if there is none. That day's section lists every highlight you made that day, older ones included. A book you add to Readwise now can add sections to many past days, because its highlights keep the dates you made them.
- **The day is yours.** It is the date of the highlight in this device's time zone.
- **Your edits stay.** While you have not changed the section, Memry rewrites it when more highlights arrive. Once you edit it, Memry never rewrites it: it only adds one line, such as `- [[Deep Work]]: 2 highlights`, for each book that got new highlights. Delete the whole section and the next new highlight of that day adds a fresh one.
- **An open entry waits.** If the day's entry is open in the editor, Memry writes it in the first sync after you close it.
- **Links follow titles.** The links use each book note's current title, and Memry keeps them valid when you rename a note. A book without a note, such as one in a category you turned off, is not listed.
- **English text.** The heading and the counts are in English, whatever language the app uses, so every device writes the same text. The editor draws the section's two comment lines as labeled bands.
- **Turning it off** stops new sections. It removes none.

## Automatic syncing

After your first import, Memry syncs without being asked.

- **On launch.** When you open Memry with Readwise connected and **Sync** set to **Hourly** or **Daily**, it runs one sync a moment after the vault opens.
- **On a schedule.** **Hourly** syncs about once an hour while Memry is open, and **Daily** once a day. **Manual** never syncs by itself: nothing runs until you press **Sync now**. Your choice is saved, so it holds after a restart and on your other devices.
- **Sync now.** The button in the Readwise dialog runs a sync right away and shows when it is done. If a sync is already running, it waits for that one instead of starting a second. It cannot join an import you started from the same dialog; wait for that one to finish.
- **Only with a token.** Memry never syncs a disconnected vault, and never starts your first import by itself: that one always waits for you, so you see the preview first.
- **Offline.** Memry skips a scheduled sync while the computer is offline and tries again on the next minute once it is back. A sync that fails because Readwise or the network is unavailable is retried after 5 minutes, then 10, 20 and so on, up to 6 hours between attempts. A sync that fails halfway writes what it finished, and the next one picks up from there.
- **A token Readwise rejects, or a subscription that expired.** Memry stops the schedule instead of trying again every hour, and tells you once. See [Sync status](#sync-status). Pasting a fresh token, or **Retry now** after you renew, resumes the schedule.

## Sync status

A background sync you cannot see is one you cannot trust. The Readwise dialog starts with a status banner that says what Memry is doing, and the row in **Settings → Import** shows the same state in a few words. Memry stays quiet while all is well.

| The banner says                        | What it means                                                                                                                                      | Action                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Synced 5 minutes ago**               | The last run finished. Below the title: what it changed, such as _1 added, 2 updated, 12 highlights_, or _nothing new_, and when the next sync is. |                       |
| **Syncing with Readwise**              | A run is going. It shows _Reading your library…_, then _Writing books, 3 of 12_.                                                                   | **Cancel**            |
| **Waiting for memry sync**             | The run waits until sync has pulled your other devices' notes, so no book is written twice. It starts by itself.                                   | **Cancel**            |
| **Syncs on Desk Mac**                  | Another device pulls from Readwise. See [Use Readwise on more than one device](#use-readwise-on-more-than-one-device).                             | **Sync here instead** |
| **Readwise needs a new token**         | Readwise did not accept the saved token, for example because you made a new one. The schedule is paused.                                           | **Paste a new token** |
| **Your Readwise subscription expired** | Readwise refused the account. The schedule is paused. Renew on readwise.io.                                                                        | **Retry now**         |
| **Readwise is limiting requests**      | Too many requests in a short time. Memry says when it tries again.                                                                                 | **Retry now**         |
| **Can't reach Readwise**               | You are offline, or Readwise is down. Memry says when it tries again.                                                                              | **Retry now**         |
| **Readwise had a problem**             | Readwise answered with a server error. Memry says when it tries again.                                                                             | **Retry now**         |

**Cancel** stops the run after the book in progress. Books already written stay, and the next run continues from where the last finished one stopped. **Paste a new token** opens a token field under the banner. It replaces the token and keeps your place, so nothing is imported again. Memry cannot tell every expired subscription from a rejected token, and in that case it shows **Readwise needs a new token**.

The row reads **Not connected**, **Connected**, **Syncing…**, **Waiting for sync**, **Synced 5 minutes ago**, **Syncs on Desk Mac**, **Needs a new token**, **Subscription expired**, **Rate limited**, **Can't reach Readwise** or **Readwise error**.

### The one notification

Memry shows one notification, and only when you must act: a rejected or revoked token, or an expired subscription. It reads **Readwise needs a new token** or **Your Readwise subscription expired**, with an **Open Readwise** button that opens the dialog. It appears once for each time the problem starts. Failed retries do not show it again, and it returns only after the problem was fixed and then came back. The banner and the row keep showing the problem until you fix it.

A network error or a rate limit shows no notification, because the next run tries again by itself. A successful run shows none either. A run that changed something adds a line to the vault activity list, as described in [Importing again](#importing-again).

## Fix one book

Three cases that importing cannot fix on its own each have a command. They appear on a note that came from Readwise, and they write into the note even while it is open, because you asked for the change.

- **Re-import from Readwise** rewrites the Readwise section from scratch. Use it after you edited the section and want Readwise's version back. It asks first, because text you wrote inside the section is lost. Text above and below the section and the note's properties stay. Afterwards the section counts as unedited again, so new highlights, edits and deletions from Readwise reach it as before.
- **Refresh book info** writes the author, category, source and source link from Readwise into the note's properties. For an article it also saves the cover image. Readwise tags the note lacks are added. No tag is removed, so a tag you added stays, and a tag Readwise dropped stays too. The note keeps its title and its place in the vault. A field Readwise has no value for is left as it is. This is the only time Memry changes the properties after the note is created.
- **Restore** brings back a note you deleted. Open the Readwise dialog and find **Deleted books**: each row has the book's title, the day you deleted the note and its highlight count. **Restore** creates the note again with all of its highlights. If a note for that book already exists, Memry links to it and does not make a second one.

Find **Re-import from Readwise** and **Refresh book info** in the note's more menu (the three dots), under **Readwise**, and in the command palette.

These commands need your token, so they run on the device that syncs with Readwise. On another device the two note commands are disabled and say that Readwise syncs on the other device, and **Deleted books** shows the same line. The list of deleted books lives on the syncing device too, so it starts empty when another device takes over.

## Choose where notes go

Once you have imported, the dialog shows your choices.

| Setting             | Default     | What it does                                                                                                                                       |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Folder**          | `Readwise`  | The vault folder new books land in. It is created the first time a note is written.                                                                |
| **Folder layout**   | By category | **By category** sorts notes into `Books`, `Articles`, `Tweets` and `Podcasts` folders. **One folder** puts every note directly in the root folder. |
| **Categories**      | See below   | One switch per category of Readwise item.                                                                                                          |
| **Readwise Reader** | Off         | **Also import saved Reader documents** and **Include full article text**. See [Readwise Reader](#readwise-reader).                                 |
| **Sync**            | Hourly      | How often Memry checks Readwise for new highlights: **Manual**, **Hourly** or **Daily**.                                                           |

Turning a category off keeps the notes you already have and skips its books on the next import. Notes of an unknown category go into an `Other` folder.

Changing the folder or the layout affects new books only. A note never moves after it is created, and a note you moved yourself stays where you put it. If you rename the root folder in Memry, the **Folder** setting follows the rename.

These choices sync to your other devices, so a device that takes over keeps them. The token does not: you paste it again on that device.

## Use Readwise on more than one device

Readwise notes are ordinary notes, so they sync to your other devices like any note. If two devices also pulled from Readwise, they could both write the same new highlight within seconds of each other. A device that opens in the morning could also read Readwise before sync has delivered the notes the other device wrote, and create a second note for every new book. So only one device pulls from Readwise at a time. The others receive the notes through sync.

- **Memry sync on.** The device where you connect Readwise becomes the one that pulls. Its name is saved with your synced settings. If another device already pulls, connecting is not offered there. Use **Sync here instead** (below).
- **Memry sync off.** There is no other device to race, so this device pulls and nothing is claimed.
- **Waiting for sync.** After Memry starts, the pulling device waits until sync has finished one pull before it reads Readwise. It then sees the notes and edits your other devices made, and it never creates a note that already exists.

### Move Readwise to another device

On a device that does not pull, the Readwise panel says **Syncs on Desk Mac**, with the name of the pulling device, and offers **Sync here instead**.

1. Click **Sync here instead**, then paste your access token again. The token never travels between devices, so each device needs its own copy.
2. Click **Sync here instead** again. Memry waits until your other devices can see the change, then finishes. Memry sync must be on and caught up for this.
3. The device that pulled before stops at its next book, deletes its copy of the token, and shows that Readwise now syncs elsewhere. Its notes stay.

The first run on the new device reads your whole Readwise library once. It recognizes the notes that already exist by their `readwise_url` property, so it does not create them again. A section you have not edited comes out identical, so nothing is written to it. In a section you edited, only highlights newer than the last one in the note are added.

::: warning A deleted note can come back once
Memry remembers that you deleted a book's note on the device that pulled. That memory stays on that device. After you move Readwise, the new device does not know, so it brings that book back once. Delete the note again and it stays deleted.
:::

## Disconnect

Click **Disconnect** in the dialog. Memry deletes the token from this device and forgets where the last sync stopped. Every note stays, and there is no option to remove them. If this device was the one that pulled, Readwise is free again, and the next device you connect becomes the new one. To connect again, paste a token.

## The row in Settings → Import

Where other sources show a file type, the Readwise row shows the state of the sync. See [Sync status](#sync-status) for every state.
