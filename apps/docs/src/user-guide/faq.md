# Frequently Asked Questions

Short answers to questions people ask about using Memry, with a link to the page that covers each one in full. The Agent Chat assistant reads this guide too, so you can also ask it these questions in your own words.

## How do I show a note on the calendar?

There are three ways:

- **A date property.** Add a `Date` [property](/user-guide/notes/properties-tags#showing-dates-on-the-calendar) to the note, then click the calendar icon on that property's row. The note shows up as an all-day chip on that date. The setting applies to every note that has a property with the same name.
- **A reminder.** Set a [reminder](/user-guide/notes/bookmarks-reminders#reminders) on the note from the note toolbar. Reminders appear on the [calendar](/user-guide/calendar#what-shows-up) on their day, and clicking one opens the note.
- **Every note on the day it was created.** Turn on **Show notes on calendar** in [Settings → Calendar](/user-guide/calendar#show-notes-on-calendar).

## Can I keep PDFs and photos in my vault?

Yes. Drop a PDF or an image onto a note, or use `/pdf` or `/image` in the editor, and Memry copies it into the vault. PDFs preview inside the note, and a double-click on the file in the sidebar opens the full viewer. See [Attachments](/user-guide/notes/attachments).

## Can I search the text inside a PDF or a photo?

Yes. Memry reads the text inside PDFs and images in your vault, including scans and photos, and search finds them by what is written on them. Text recognition runs on your device. See [Text in PDFs and images](/user-guide/search#text-in-pdfs-and-images).

## Can I annotate or highlight a PDF?

No. Memry does not support annotations on PDFs yet. You can't highlight, underline, or draw on a PDF page in Memry.

As a workaround, embed the PDF in a note and write your comments around it in the note, or open the PDF in another app from the viewer's `⋯` menu with **Open in default app**.

## How does Memry update itself?

Memry checks for a new version 10 seconds after its window opens and then every 4 hours. When one is found, the Settings gear on the rail gets a dot. Click the gear to download the update, restart into it now, or let it install the next time you quit. You can also turn on automatic downloads, skip a version, or turn checks off. See [Updates](/user-guide/settings#updates).

The Linux `.deb` package does not update itself. Install the new `.deb` from the release page instead.

## Is my vault safe if an update fails?

Yes. An update replaces the app, not your notes, and the vault is never part of the install. When an install does not finish, Memry opens on the version you had and shows **MemryNote couldn't finish installing** with a manual download. See [Updates](/user-guide/settings#updates).

## Why does Windows say Memry needs the WebView2 Runtime?

Memry draws its window with Microsoft Edge WebView2, a part of Windows 10 and 11 that can be removed. When Memry starts without it, it installs the runtime from a copy of Microsoft's installer that ships with the app. A box says **MemryNote is installing the Microsoft Edge WebView2 Runtime** while that runs, which can take up to two minutes, and then Memry opens.

If the install does not work, for example because the computer is offline, a box titled **MemryNote can't start** explains what is missing. Choose **Yes** to open Microsoft's download page, run the installer, then open Memry again.
