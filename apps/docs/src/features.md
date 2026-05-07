# Features

Memry combines writing, reflection, and planning in one private workspace.

## Notes

- Rich text editing for long-form notes
- Markdown-friendly writing
- Wiki-style `[[links]]` between notes
- Backlinks and graph-oriented navigation

## Journal

- Daily note space for reflection
- Calendar-oriented browsing
- Activity context for building a writing habit

## Tasks and Projects

- Tasks live alongside notes instead of in a separate system
- Priorities, due dates, and project organization
- Drag-and-drop planning flows

## Offline-First Storage

Memry stores workspace data locally so core flows do not depend on a network connection.
The desktop app uses SQLite-backed local storage and keeps the server out of the critical
path for everyday writing.

## Private Sync

Sync is designed around end-to-end encryption. Devices encrypt data before it leaves the
machine, and the server stores encrypted payloads it cannot read.
