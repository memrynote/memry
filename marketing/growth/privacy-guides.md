# Privacy Guides

Issue #3465. Privacy Guides lists notebooks on [privacyguides.org/en/notebooks](https://www.privacyguides.org/en/notebooks/),
and privacy-minded users pick a notes app from that page. This file checks memrynote against the
page's criteria, says how a project gets onto the page today, and holds a forum post draft.
Nothing has been posted.

The security white paper that a listing needs is `apps/docs/src/architecture/security-white-paper.md`.
It goes live at `https://docs.memrynote.com/architecture/security-white-paper` when the branch
merges to `main`.

## The showcase category is closed to memrynote

Checked on 2026-11-17:

- Since 2026-10-31, only `@verified` accounts may post in the forum's Project Showcase category.
  `@verified` is for projects that Privacy Guides already recommends. "There are no exceptions
  possible" ([announcement](https://discuss.privacyguides.net/t/update-to-project-showcase-posting-policy/41893)).
- Self-promotion anywhere else on the forum is removed as spam
  ([guidelines](https://discuss.privacyguides.net/guidelines#promotion)).
- Privacy Guides considers only projects that community members bring forward on the forum
  ([criteria](https://www.privacyguides.org/en/about/criteria/)).
- A developer in the `@developers` group may answer questions about their own project in existing
  threads, but may not start a topic to promote it
  ([category rules](https://discuss.privacyguides.net/t/about-the-project-showcase-category/114)).

So Kaan cannot open the showcase post the issue planned. What remains:

1. Publish the white paper, so a community member who suggests memrynote has a document to link.
2. Ask the Privacy Guides team to join `@developers`, with an address on the `memrynote.com`
   domain. Then answer questions in threads where users ask about memrynote or about encrypted
   notes apps, and say in each reply that you build it.
3. Keep the post below for the day memrynote is recommended and the account is `@verified`. It
   also works as the base for replies in step 2.

Writing a suggestion for someone else to post would break the forum's rules, so this file has none.

## Criteria check

The notebooks page has three minimum requirements and two best-case ones
([criteria](https://www.privacyguides.org/en/notebooks/#criteria)).

| Criterion                                           | memrynote                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients must be open source                         | Yes. Desktop, iOS, CLI, web clipper and sync server are in `github.com/memrynote/memry` under AGPL-3.0.                                                                             |
| Cloud sync must be end-to-end encrypted             | Yes. The white paper describes what the server can and cannot read.                                                                                                                 |
| Export to a standard format                         | Yes. Notes and journal entries are Markdown files with YAML frontmatter in the vault folder. Tasks and projects sit in a SQLite file in the vault, and the CLI prints them as JSON. |
| Best case: local backup or sync supports encryption | No. The vault on disk is plain files, so its protection is the operating system's disk encryption.                                                                                  |
| Best case: cloud platforms support sharing          | No. memrynote has no document sharing.                                                                                                                                              |

The general criteria
([criteria](https://www.privacyguides.org/en/about/criteria/)) ask for security best practice,
open source, cross-platform support, active development, usability and documentation. Expect
these questions in any thread:

- **Audit.** No independent audit yet. The white paper says so.
- **Platforms.** macOS, Windows and Linux. iPhone is a TestFlight beta. No Android.
- **Telemetry.** Anonymous usage metrics and automatic error reports are on by default, and both
  can be turned off in Settings > General > Privacy. Readers on this forum see opt-out telemetry as a drawback, so say it before
  someone else does.
- **AI.** The agent is optional. With a cloud model, the notes it reads go to that provider.
- **Who runs it.** One developer, funded by sync plans.

## Post draft

Privacy Guides rejects low-effort and AI-written showcase posts, so rewrite this in your own words
before posting. The facts in it match the white paper.

**Title:** memrynote: local-first notes, tasks and journal with end-to-end encrypted sync (AGPL-3.0)

**Body:**

> Hi, I'm Kaan, and I build memrynote, so I'm biased. I'm posting for feedback on the security
> design.
>
> memrynote is a desktop app for notes, tasks, a daily journal and a calendar. The vault is a
> folder of Markdown files on your disk, and the app works offline without an account. Sync
> between devices is optional and paid, and it is the only paid part.
>
> How sync protects your data:
>
> - Your 24-word recovery phrase becomes a master key through BIP39 and Argon2id, on your device.
>   The server never receives the phrase, and sees the master key only encrypted, while it relays
>   it to a device you link.
> - Each record gets a random key, is encrypted with XChaCha20-Poly1305, and is signed with the
>   device's Ed25519 key. Note bodies sync as encrypted Yjs updates in the same way.
> - The server stores ciphertext plus the metadata it needs to route it: your email, record ids
>   and types, sizes, timestamps, vector clocks and the devices on your account. Some ids are
>   readable, such as tag names, folder paths and journal dates. The white paper lists all of it.
> - A new device gets the master key from one you already have, over an X25519 exchange that
>   you confirm with a 6-digit code.
>
> What it does not do yet:
>
> - No independent audit.
> - No key rotation, and revoking a device does not change any key.
> - The vault on disk is plain Markdown, so use full-disk encryption.
> - Anonymous usage metrics and automatic error reports are on by default. Settings > General >
>   Privacy turns them off.
> - No Android app, and the iPhone app is in beta.
>
> White paper: https://docs.memrynote.com/architecture/security-white-paper
> Protocol specification: https://github.com/memrynote/memry/tree/main/docs/protocol
> Source: https://github.com/memrynote/memry
> Site: https://memrynote.com/?utm_source=privacyguides&utm_medium=referral&utm_campaign=showcase
>
> I'd like to hear where the design falls short, especially the metadata the server keeps.
