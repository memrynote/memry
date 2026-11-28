# What Notes on iOS and iPadOS 27 can hand to another app

Research for GitHub issue #4670 (memrynote/memry). Draft, fetched 2026-11-17. No device was used. Nothing here was run on iOS 27.

**Answer.** Third-party apps cannot read the Notes database. A user can hand over one note at a time. Apple documents three single-note exports in the iOS 27 and iPadOS 27 guides: Export as Markdown, PDF (through Markup) and Open in Pages. Share, then "Send a Copy" also exists, but Apple does not say which data types a receiving app gets. Apple documents no bulk export, no folder export and no multi-note share on iOS or iPadOS. Markdown is the only structured, text-based format Apple offers, and it is the best input for an importer. Reports say a Markdown export with images writes a Markdown file plus an Attachments folder (tested on macOS 27, reported for iOS). No source says whether created and modified dates survive. Locked notes must be unlocked first. Several important claims rest on vendor blogs or older iOS versions, so they need a device check (see "Check on a device").

Evidence levels used below: **(a)** documented by Apple, **(b)** reported by press, vendors or developers, **(c)** not verified, needs a device check. Numbers in brackets point to "Sources".

## Summary table

| Path                                                         | Format                                                                     | Bulk                         | Attachments                                                                                                         | Dates                         | Locked notes                                                                       | Evidence                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Share, Export as Markdown (iPhone, iPad)                     | `.md`; with images, an `.md` plus an `Attachments` folder, possibly zipped | One note at a time           | Images copied beside the file and linked (b, macOS 27 test; iOS zip reported by one vendor). Other types unknown    | Not documented, not confirmed | Unlock first (b, inferred; Apple silent)                                           | Exists: (a) [1][2]. Layout: (b) [14][18]. Rest: (c)                |
| Share, Markup (PDF)                                          | PDF                                                                        | One note                     | Uses the note's view settings; multipage PDF or scan keeps first page only (a)                                      | Not documented                | Not documented                                                                     | (a) [1][2]                                                         |
| Share, Open in Pages                                         | Pages document                                                             | One note                     | Scans and PDFs become thumbnails; drawings not editable; checklists, tags, mentions, note links become inactive (a) | Not documented                | Must unlock first (a)                                                              | (a) [3] (iOS 26 page; same text sits on the iOS 27 page) [1]       |
| Share, Send a Copy                                           | Unknown data types                                                         | One note                     | Unknown for iOS 27                                                                                                  | Unknown                       | Unknown                                                                            | Exists: (a) [4]. Types: (b) older iOS [23][24][25], (c) for iOS 27 |
| Share, Share a Link (Collaborate)                            | iCloud link, not a file                                                    | Note or folder               | Not applicable                                                                                                      | Not applicable                | Not allowed: cannot collaborate on a locked note or a folder with locked notes (a) | (a) [4]                                                            |
| Select several notes, Share                                  | Not documented                                                             | Not documented               | Not documented                                                                                                      | Not documented                | Not documented                                                                     | (c)                                                                |
| Select several notes, drag into Files (iPad)                 | RTFD packages                                                              | Several notes                | Scans do not come along                                                                                             | Unknown                       | Unknown                                                                            | (b) one vendor [19], (c)                                           |
| Shortcuts: Find Notes, loop, Make Markdown or PDF, Save File | Whatever the shortcut writes                                               | Yes, user-built              | Not tested by anyone found                                                                                          | Not tested                    | Skipped in related AppleScript path (b); Shortcuts untested                        | Actions exist: (b) [20]. Bulk recipe: (b) [19]. Behavior: (c)      |
| Apple Account data copy (privacy.apple.com)                  | `.txt` per note                                                            | All iCloud notes             | Beside the text; drawings lost                                                                                      | Unknown                       | Excluded                                                                           | (b) [19]                                                           |
| Mac only: File > Export To (macOS 27)                        | PDF or Markdown                                                            | Selection of notes works (b) | `Attachments` folder beside the files                                                                               | Not confirmed                 | Unlock first                                                                       | Single note: (a) [7]. Bulk and layout: (b) [14][19]                |

## Share sheet from one note

**What Apple documents.** Open the note, tap Share, tap the menu under the title, then "Send a Copy" or "Share a Link" [4]. "Send a Copy" sends a copy to a friend. "Share a Link" starts iCloud collaboration. Apple lists no data types for either.

**What a receiving app gets.** Apple has no statement. Evidence from developers, all older than iOS 27:

- iOS 10 era: reading `NSExtensionItem.attributedContentText` gave fonts but not lists, indents or headings [24].
- iOS 11 era: a receiving action extension saw one provider of type `public.plain-text` [25].
- Nov 2024 (iOS 18 era): a share extension needed to loop over all items for `public.plain-text` and `public.image` providers when a note had both text and images. The first item alone was not enough [23].

No source I found shows `public.rtf`, `public.html`, `public.url` or any `com.apple.notes.*` type arriving from Notes. I found no document that describes a copy-link item in the "Send a Copy" payload either. All of this is (b) for old versions and (c) for iOS 27.

**Title, checklists, tables, links.** No source covers the share-sheet payload. The Pages path (documented) drops checklists, tags, mentions and note links as active items [3]. Treat the share-sheet payload as plain text without structure until a device check says otherwise.

**iOS 27 changes.** I found no iOS 27 change to the share sheet. The documented iOS 27 Notes additions are divider lines, section links, paste and copy as Markdown, and Siri AI controls [10][15][22][29]. A divider shows as `---` on iOS 26 devices [22]. Section links and dividers are new constructs an importer may meet in Markdown (c).

## Share from several notes or from a folder

- Apple documents sharing a note or a folder only as iCloud collaboration through a link [4]. That path carries no file.
- Apple documents no way to select several notes and export or send them on iPhone or iPad. One vendor says iOS is still one note at a time and cites a September 2026 walkthrough [19].
- The same vendor says selecting several notes and dragging them into Files on an iPad gives RTFD packages without scans [19]. It did not test the result. (c)
- The same vendor reports that some iPadOS 26 users export several notes as Markdown from the menu bar, and a forum thread from October 2025 reports duplicated lines and blank files in batches above 100 notes [19]. Unconfirmed. (c)

## Export

**Markdown.** Apple: open the note, Share, "Export as Markdown" (tap View More if hidden), then "Choose how to send or save your note" [1][2]. Press confirmed the same for iOS 26 [11][12][13]. Apple's page does not describe the file layout.

**Layout and fidelity.** A vendor tested a note with a checklist, a table, a tag, a link to another note and a picture on **macOS 27** (not iOS) [14]:

- Export writes a folder named by the user. Inside are the Markdown file (named after the note title) and an `Attachments` folder. Images are linked from the text.
- Headings, bold and lists are kept. Checklists keep ticks as `- [x]` and `- [ ]`. Tables become pipe tables, and a two-line cell breaks the row. Tags stay as `#tag` text.
- The vendor says links to other notes and web links are dropped. A second vendor says web links come through on macOS 26 [19]. These conflict. (c)
- Every line ends in two spaces.

A third vendor says per-note zips shared from iOS contain the Markdown plus an `Attachments` folder [18]. It names no iOS version. (b)

**PDF.** Share, then Markup, then Done saves a PDF. It uses the note's view settings. A multipage PDF or scan keeps only its first page [1][2].

**Pages.** Share, then Open in Pages. The Pages guide for iOS 26 says scans and PDFs become thumbnails, drawings are not editable, and tags, mentions, checklists and note links are inactive [3].

**Other.** Print exists [1]. Apple's data copy (privacy.apple.com) gives `.txt` per note, only for iCloud notes, without locked notes (one vendor) [19]. I fetched no Apple page that describes the format of that copy. (b)

**Mac, labelled.** macOS 27 has File > Export To with PDF or Markdown for one note, Edit > Copy as Markdown, and File > Import Markdown [7]. Vendors report that selecting many notes and exporting writes one Markdown file per note and an `Attachments` folder, and that folders are flattened into one "Archive" folder [19]. (b)

## Files and folder structure

- The Markdown export ends at "choose how to send or save" [1]. Save to Files, AirDrop and Mail are available per a vendor [14]. So one note can land in Files or iCloud Drive. (a for the save step, b for the exact options.)
- No source documents a folder-level export that keeps Notes folder structure on iOS or iPadOS. A Shortcut can build one (see below). Mac import can keep structure when it reads a folder [7], but that is import, not export.
- Whether the Files result for a note with images is a folder, a zip or a flat file is not confirmed on iOS 27. (c)

## Locked notes

- Pages: must unlock before export [3]. (a)
- Share a Link: not possible for a locked note or a folder with locked notes [4]. (a)
- Apple says notes with tags, PDFs, audio, video or Keynote, Pages or Numbers documents cannot be locked [27]. So a locked note holds no such attachments (a).
- Markdown, PDF, Send a Copy: Apple says nothing. Vendors say unlock first [14][19]. (b)
- Locked notes are skipped by AppleScript tools and by Apple's data copy [16][19]. (b)

## Dates

No Apple page and no vendor page I read says that the Markdown, PDF, Pages or Send a Copy output carries created or modified dates. One vendor could not confirm it for Markdown and cites a Reddit thread that says no [19]. A Mac importer that reads notes through AppleScript says it keeps written and last-changed days [30], but that is a different path. Plan for no dates and for whatever the file system gives (c).

## Shortcuts actions for Notes

Apple documents the iOS 27 updates: "Create Note" and "Append Text to Note" now support Markdown, and "Append Text to Note" can append or prepend to a specific section of a note [9]. (a)

The Notes action list as of Aug 2025 (iOS 26): Add File, Append Checklist Item, Append to Note, Create Note, Delete Notes, Find Notes, Open Note, Pin Notes, Rename Folder, Scan Documents, Show Notes Folder, Show Quick Note, plus account, app, folder and tag actions [20]. A vendor counts 24 actions on macOS 27 and says there is no action to edit a note [16]. Another site counts 49 actions without a list [21]. (b)

- I found no "Get contents of note" action. The Notes actions do not read the body directly. (b, absence in the list [20])
- "Find Notes" returns Note objects. The recipes that exist feed them to "Repeat with Each", then "Make Markdown from Rich Text" or "Make PDF", then "Save File" [19]. A public shortcut converts all notes to Markdown into a `notes-export` subfolder. Its README lists attachments and front matter as not done, and iOS and iPadOS as unverified [31]. (b)
- Which Note properties Shortcuts exposes (name, body, folder, created, modified) was not documented in anything I read. (c)
- Apple's Developer Technical Support says Notes has no API, AppleScript is Mac only, and Shortcuts cannot be used to get around that. An app can only appear as a Shortcuts target [17]. A third-party app cannot call Find Notes itself. A user can run a shortcut that writes files, and the app then imports the files. (a)
- Siri AI in iOS 27.3 can create, update and delete notes, folders and tags and more [29]. It is not an export path. (b)

## Recommended input format for phase 1

**Commit to Markdown files from Notes' own "Export as Markdown": one `.md` file, or a folder or zip that holds one `.md` plus an `Attachments` folder.** The importer should accept several of these at once through the Files picker, and a folder of them.

Why:

1. It is the only first-party structured export Apple documents for iOS 27 and iPadOS 27 [1][2]. PDF is lossy and Pages is a closed package [1][3].
2. It keeps headings, lists, checklist ticks, simple tables and images, based on the macOS 27 test [14].
3. It matches the Mac path (File > Export To and bulk selection), so one importer serves iPhone, iPad and Mac [7][19].
4. Markdown is plain text, so a user can check the file before importing.

Known losses to design for: note links, possibly web links, dates, locked notes, non-image attachments, and a two-line table cell [14][19]. Expect new `---` dividers and section links from iOS 27 notes [10][22].

**Fallback.** For users who cannot export per note: (1) a share extension that accepts `public.plain-text` and `public.image` items from "Send a Copy" and treats the first line as the title [23][25]; and (2) for whole libraries, a Mac-side bulk Markdown export the user feeds to the same importer [19]. A user-built Shortcuts loop that writes `.md` files is a third route, but no one has proven it with attachments [31].

## Check on a device

Run on an iOS 27.x iPhone and an iPadOS 27.x iPad with a test note holding: title, headings, a checklist with one ticked item, a table, a web link, a link to another note, a tag, an image, a PDF, a drawing, a divider and a section link. Also make one locked note and one shared note.

- [ ] Share, Export as Markdown: is the result one `.md`, a folder, or a zip? Where is the `Attachments` folder? File names for the note and its images?
- [ ] Does the Markdown keep the title as a heading? What happens when the title and the first line differ?
- [ ] Are web links kept? (Vendors disagree [14][19].) Are links to other notes dropped?
- [ ] How do checklists, tables with multi-line cells, tags, dividers and section links look in the file?
- [ ] Are non-image attachments (PDF, scan, audio, drawing) exported, skipped or turned into thumbnails?
- [ ] Do the `.md` or the zip entries carry created and modified dates in file metadata or in front matter? Compare with the note's dates in Notes.
- [ ] "Save to Files" on iCloud Drive: what exact item lands there?
- [ ] Export as Markdown on a locked note while it is unlocked, and while it is locked. Same for PDF and Send a Copy.
- [ ] Send a Copy to a test share extension: log every `NSItemProvider` registered type identifier (plain text, RTF, HTML, URL, image, file, any `com.apple.notes.*`). Check `attributedContentText` and whether a copy-link item appears.
- [ ] Select several notes in the list: is Share, Export or drag available? What does a drag into Files produce (RTFD?) and does it keep dates?
- [ ] Select a folder: any Share or Export action besides collaboration?
- [ ] Shortcuts: what properties does "Find Notes" output expose (title, body, created, modified, folder)? Does "Make Markdown from Rich Text" work on a Note? Is there any "Get Contents of Note" or "Get Details of Notes" on iOS 27?
- [ ] Shortcuts bulk recipe on 100 notes: duplicated lines, blank files, attachments?
- [ ] iPadOS 27 menu bar: multi-select then File > Export as Markdown?
- [ ] Notes in a Gmail or On My iPhone account: does export behave the same?

## Sources

All fetched 2026-11-17. The Apple Support guide pages come back truncated through the Jina fallback, so I read the full text with a plain HTTP fetch of the same URLs.

1. Apple, Export or print notes on iPhone (iOS 27). https://support.apple.com/guide/iphone/export-or-print-notes-iphdf551cfa2/27/ios/27
2. Apple, Export or print notes on iPad (iPadOS 27). https://support.apple.com/guide/ipad/export-or-print-notes-ipad50c393a8/27/ipados/27
3. Apple, Export or print notes on iPhone (iOS 26, Open in Pages with the unlock note). https://support.apple.com/guide/iphone/export-or-print-notes-iphdf551cfa2/26/ios/26 (iPad: https://support.apple.com/guide/ipad/export-or-print-notes-ipad50c393a8/26/ipados/26)
4. Apple, Share notes and collaborate on iPhone (iOS 27). https://support.apple.com/guide/iphone/share-and-collaborate-iphe4d04f674/27/ios/27
5. Apple, Lock your notes on iPhone (iOS 27). https://support.apple.com/guide/iphone/lock-notes-iphf177bb154/27/ios/27
6. Apple, Import or share notes and files to the Notes app (published 2026-04-02). https://support.apple.com/en-us/102223
7. Apple, Import, export, and print notes on Mac (Notes 4.13, macOS 27). https://support.apple.com/guide/notes/import-export-and-print-notes-not201900c07/4.13/mac/27
8. Apple, Share notes and collaborate in Notes on Mac (macOS 27). https://support.apple.com/guide/notes/share-notes-and-collaborate-apd4e6e2c9a6/4.13/mac/27
9. Apple, New in iOS, iPadOS, macOS, watchOS, and visionOS 27 (Shortcuts). https://support.apple.com/en-us/149045
10. 9to5Mac, Here's what's new for Apple Notes in iOS 27 (2026-09-28). https://9to5mac.com/2026/09/28/heres-everything-new-for-apple-notes-in-ios-27/
11. MacRumors, iOS 26: Import and Export Markdown Files in Apple Notes. https://www.macrumors.com/how-to/ios-import-export-markdown-apple-notes/
12. AppleInsider, How to import and export Markdown with Apple Notes in iOS 26 (2026-01-12). https://appleinsider.com/inside/ios-26/tips/how-to-import-and-export-markdown-with-apple-notes-in-ios-26
13. 9to5Mac, Apple Notes in iOS 26 works better than ever with Markdown (2025-08-28). https://9to5mac.com/2025/08/28/apple-notes-in-ios-26-works-better-than-ever-with-my-favorite-writing-tool/
14. Pinto Notes (vendor), How to export Apple Notes to Markdown (tested on macOS 27, 2026-10-14). https://pintonotes.com/blog/export-apple-notes-to-markdown
15. Pinto Notes (vendor), What's new in Apple Notes in iOS 27. https://pintonotes.com/blog/apple-notes-ios-27
16. Pinto Notes (vendor), Apple Notes API: Apple says no (cites Apple DTS, counts macOS 27 Shortcuts actions). https://pintonotes.com/blog/apple-notes-api
17. Apple Developer Forums, Is there an API for Apple Notes? (Apple DTS answer). https://developer.apple.com/forums/thread/813810
18. PrivacyNotes (vendor), Export your Apple Notes (iOS per-note zip claim). https://privacynotes.app/help/import/apple-notes
19. Harbor (vendor), How to export all your Apple Notes at once. https://harbor.my/blog/export-apple-notes/
20. MacNative, List of Notes Actions for iOS Shortcuts (as of 2025-08-30). https://macnative.com/list-of-notes-actions-for-ios-shortcuts/
21. Shortcut Actions, Notes actions (49 actions, no list). https://www.shortcutactions.com/actions/app/notes
22. iApplist, Apple Notes in iOS 27: 8 new features. https://iapplist.com/apple-notes-ios-27/
23. Stack Overflow, iOS Share extension from Notes app, collect text and images (Nov 2024). https://stackoverflow.com/questions/79202492/ios-share-extension-from-notes-app-need-to-collect-text-and-images-simultaneous
24. Stack Overflow, How to share a note including markup with share extensions (2016). https://stackoverflow.com/questions/39828800/how-to-share-a-note-including-markup-with-share-extensions-swift
25. Apple Developer Forums, NSItemProvider loadItemForTypeIdentifier never completes on iOS 11 GM (Notes action extension, `public.plain-text`). https://developer.apple.com/forums/thread/86946
26. Casebx (low-quality SEO page, not relied on), Apple Notes Markdown Import & Export on iPhone (iOS 27). https://casebx.com/blogs/how-to/apple-notes-markdown-import-export-not-working
27. Apple, How to lock or unlock notes on your iPhone or iPad. https://support.apple.com/102537
28. Apple, iPhone User Guide table of contents (iOS 27), used to confirm the Notes chapter has no bulk export page. https://support.apple.com/guide/iphone/toc
29. 9to5Mac, Apple Notes adds a powerful new advantage in iOS 27.3 (2026-11-12). https://9to5mac.com/2026/11/12/apple-notes-adds-a-powerful-new-advantage-in-ios-27-3/
30. Pinto Notes (vendor), How to move from Apple Notes to Pinto Notes (Mac import, dates, locked notes). https://pintonotes.com/blog/move-from-apple-notes
31. GitHub, mgooley/apple-notes-to-markdown-shortcut README. https://github.com/mgooley/apple-notes-to-markdown-shortcut

Not found: any Apple WWDC26 session, release note or developer document about what Notes hands to a share extension, and any Apple page that says whether exported files carry dates. The Apple Community thread on bulk export (https://discussions.apple.com/thread/256195803) blocked the fetch, so only its search snippet was seen (Find Notes, Repeat with Each, Make PDF, Save File).
