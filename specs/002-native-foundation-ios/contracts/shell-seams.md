# Shell seams — the eight foreign traits

**Feature**: 002-native-foundation-ios. **Source**: `crates/memry-core/src/seams/`.
**Invariant**: data-model §D.7, spec FR-017.

## The list is closed

Eight traits. **Adding a ninth requires a written justification in the
specification**, because every seam is a place a shell can grow logic the core
was supposed to own (Constitution I).

The rule that decides whether something is a seam: _can only the platform do
it?_ A Keychain write, a data-protection class, a `URLSession` request and a
camera are all things the core physically cannot do. Merge, clocks, crypto,
retry, backoff, cursors and schema are all things it can, and none of them
crosses.

| #   | Trait            | File               | Async | What only the platform can do                   |
| --- | ---------------- | ------------------ | ----- | ----------------------------------------------- |
| 1   | `SecureStore`    | `secure_store.rs`  | no    | Keychain, under the core's access policy        |
| 2   | `FileProtection` | `storage.rs`       | no    | data-protection class, backup exclusion, space  |
| 3   | `Notifications`  | `notifications.rs` | yes   | local notification scheduling and permission    |
| 4   | `BackgroundExec` | `background.rs`    | no    | background task registration and expiry warning |
| 5   | `Reachability`   | `reachability.rs`  | no    | network reachability transitions                |
| 6   | `Transport`      | `transport.rs`     | mixed | HTTP and the realtime socket                    |
| 7   | `EditorHost`     | `editor.rs`        | mixed | the WebView bridge relay                        |
| 8   | `CodeCapture`    | `capture.rs`       | yes   | optical code capture                            |

Three of these carry a companion trait the core implements and the shell calls
back into: `LifecycleObserver`, `ReachabilityObserver`, and the socket pair
`SocketListener` / `SocketHandle`.

## Transport is one trait, and it is dumb

`send(request)` and `open_socket(...)` live on **one** trait. Both are the same
seam to the same host, and splitting them buys a second implementation of the
same lifetime rules.

One request in, status plus headers plus bytes out. **Every** retry, backoff,
token refresh and protocol decision stays in Rust. A shell that adds a retry
here duplicates a policy the core already owns, and the two disagree the first
time either changes.

Two details that are contract, not convention:

- **Header keys are lowercase in both directions.** Chapter 00 §0.6 reads
  `retry-after` from a 429 in lowercase; normalising at the seam is what saves
  every reader in the core from guessing the shell's casing.
- **A non-2xx status is a response, not an error.** The core reads the body to
  find the error code (chapter 00 §0.4). `TransportError` is for the cases where
  no response exists at all, and the retry ladder branches on which one it got —
  `Tls` is not retryable, `Cancelled` must not count against a retry budget.

`open_socket` is **synchronous**. Readiness arrives as `SocketListener::on_open`
and failure as `on_error`, so awaiting the open would report the same facts
twice through two channels. It also sidesteps a UniFFI limitation: an async
foreign method cannot return an `Arc<dyn Trait>`, because the desugared future is
generic over a lifetime the generated `FfiConverterArc` impl is not.

The socket is **never a data path** (chapter 09). A message is a hint that causes
a pull; nothing is applied from it. `on_message` carries bytes rather than a
parsed type precisely so the shell cannot grow an opinion about the frame.

## Why these particular enums have the variants they do

A seam error that collapses two cases produces a specific wrong behaviour, and
each of these was chosen to prevent one:

| Variant                              | What collapsing it would do                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecureStoreError::Locked`           | reading "no master key" from a locked device and re-registering, throwing the key away                                                         |
| `TransportError::Cancelled`          | charging a user's own cancel against the retry budget                                                                                          |
| `TransportError::Tls`                | retrying a certificate failure, turning a possible interception into a loop                                                                    |
| `NotificationError::LimitReached`    | silently dropping reminders past iOS's 64 pending cap instead of letting the core choose which to hold                                         |
| `CapturePermission::Restricted`      | sending a user to Settings to grant a permission an MDM profile will not let them grant                                                        |
| `StorageError::IndexRebuildRequired` | treating a corrupt search index as data loss instead of deleting and rebuilding the file, which is the whole reason the index has its own file |
| `BackgroundError::Unavailable`       | failing quietly when Background App Refresh is off, instead of saying the capability is absent (Constitution IV)                               |

## SecureStore takes bytes

Every value is `Vec<u8>`. The master key is 32 raw bytes and the device signing
key is 64; rendering either as a `String` to cross the FFI puts a secret in Swift
storage the core cannot zero (constitution 2.1.0, FR-023).

The key is an **enum**, not a string, so a typo is a compile error and so a shell
cannot invent a sixth entry the core does not know about. The five entries are
chapter 01 §1.8's, under service `com.memry.sync`.

The access policy is the **core's**, applied by the shell: after first unlock,
this device only, never synchronised to iCloud, never in a backup. The shell does
not get to choose — a shell that picks `whenUnlocked` breaks the background
refresh that runs before the first unlock after a reboot.

## EditorHost carries no markdown

The core owns the Y.Doc; the WebView owns markdown. This seam relays a JSON
message each way and reads neither.

**The core never parses or serialises markdown** (chapter 12 §12.1). Both
directions belong to the bundle: document to markdown is `export-markdown`,
markdown to document is `seed-from-markdown`, and a new note's `content` payload
is handed to the guest **verbatim** so the bundle's own frontmatter splitter runs
there. A markdown crate in `memry-core` would be a second markdown implementation
on the phone path, and two implementations is how byte identity dies (D.1).

A `BRIDGE_PROTOCOL_VERSION` mismatch is a hard failure rather than a degraded
mode: the bundle and the core ship together, so a mismatch means the build
pairing broke.
