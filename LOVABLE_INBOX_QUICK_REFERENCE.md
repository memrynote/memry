# Inbox Filing Page - Quick Reference for Lovable.dev

## 🎯 What is This?

A detailed specification for building the **Inbox Filing feature** in Memry - the page where users process captured items by filing them to folders, converting to notes, or deleting them.

## 📍 File Location

**Full Specification**: `LOVABLE_INBOX_FILING_PROMPT.md` (1000+ lines, comprehensive)

## 🚀 Quick Start for Lovable

### Copy This Prompt to Lovable

1. Open [Lovable.dev](https://lovable.dev)
2. Create a new project
3. Copy the entire content of `LOVABLE_INBOX_FILING_PROMPT.md`
4. Paste into Lovable chat
5. Follow the specifications to build components

### Key Sections in the Prompt

| Section                               | Purpose                                            |
| ------------------------------------- | -------------------------------------------------- |
| **Overview**                          | High-level purpose of filing feature               |
| **Page Layout & Architecture**        | Visual structure and component hierarchy           |
| **Detailed Component Specifications** | Component-by-component breakdown                   |
| **User Workflows**                    | Real user journeys (file, convert, snooze, delete) |
| **Data Flows & State Management**     | State to track and API interactions                |
| **Visual Design & Styling**           | Colors, typography, spacing, animations            |
| **Accessibility**                     | Keyboard nav, screen reader support                |
| **Success Criteria**                  | What constitutes a complete implementation         |
| **Implementation Priority**           | MVP → Phase 2 → Phase 3                            |

## 🎨 Core Components to Build

### 1. **Inbox Detail Panel**

- Item preview (type-specific rendering)
- 7 different preview formats: link, note, image, voice, PDF, clip, social
- Action buttons: File, Convert to Note, Link to Note, Snooze, Delete
- Tags management
- Metadata display

### 2. **Filing Panel (Modal/Sheet)**

- Folder tree selector (browsable + searchable)
- Smart suggestions (2-3 folders based on content)
- Tags input with autocomplete
- Filing options (checkboxes)
- File to folder functionality

### 3. **Bulk Filing Panel**

- Multi-item selection display
- Same filing workflow as single items
- Applies to all selected items at once

### 4. **Snooze Picker**

- Quick options: Later Today, Tomorrow, Next Week, Custom
- Optional reason text field
- Hides item from inbox until snooze time

### 5. **Convert to Note Dialog**

- Note title input
- Destination folder selector
- Include options (content, tags, metadata, attachments)
- Creates markdown file in vault

### 6. **Link to Note Selector**

- Search notes
- Recent notes list
- AI suggestions (similar notes)
- Tree view of all notes

### 7. **Delete Confirmation**

- Warning message
- "Type DELETE to confirm" input
- Permanent deletion warning

### 8. **Bulk Action Bar**

- Selection count
- File, Tag, Delete, More buttons
- Clear selection button

---

## 🎭 Preview Types by Item Type

```
LINK       → Hero image + title + excerpt + source metadata
TEXT NOTE  → Markdown-formatted text preview
IMAGE      → Thumbnail + dimensions + file size
VOICE      → Audio player + transcription text
CLIP       → Block quote styling + source attribution + images
PDF        → Thumbnail + metadata (pages, author) + text excerpt
SOCIAL     → Tweet-like card with avatar, handle, post text, media, metrics
```

---

## 🔄 Key User Workflows

### Workflow 1: File Single Item

1. Click item → Detail panel opens
2. Click "File to Folder" → Filing panel opens
3. Browse/search folders → Select destination
4. (Optional) Add tags
5. Click "File Item" → Item moves to folder, removed from inbox

### Workflow 2: Bulk File

1. Select multiple items (Cmd+Click, Cmd+A)
2. Bulk action bar appears
3. Click "File"
4. Same filing panel with all items shown
5. File all to same destination

### Workflow 3: Convert to Note

1. Click item
2. Click "Convert to Note"
3. Edit title, select location, choose what to include
4. Click "Create Note" → New markdown file created in vault

### Workflow 4: Snooze

1. Click "Snooze" button
2. Pick time: Later Today, Tomorrow, Next Week, or Custom
3. Item disappears from main view
4. Item returns when snooze time expires

### Workflow 5: Delete

1. Click "Delete" button
2. Type "DELETE" to confirm
3. Item permanently removed (cannot be undone)

---

## 🎨 Design System Requirements

### Colors by Item Type

- **Link**: Teal/Blue (#0891b2)
- **Note**: Gray (#64748b)
- **Image**: Purple (#a855f7)
- **Voice**: Orange (#f97316)
- **Clip**: Indigo (#6366f1)
- **PDF**: Red (#ef4444)
- **Social**: Sky Blue (#0ea5e9)

### Button States

- **Primary**: Teal background (File, Create)
- **Secondary**: Gray background (Cancel, Link)
- **Danger**: Red background (Delete)
- **Disabled**: Grayed out with muted text

### Spacing & Typography

- Standard padding: 16px
- Section gap: 12px
- Border radius: 8px
- Font sizes: Title 18px bold, Body 14px regular, Metadata 12px light

### Animations

- Panel open/close: 300ms slide
- Button click: 150ms scale + shadow
- Success toast: Auto-dismiss after 3s

---

## 🛠️ State Management Structure

```typescript
interface InboxFilingState {
  // Selection
  selectedItems: string[]
  selectedItem: InboxItem | null

  // Modals
  isFilingPanelOpen: boolean
  isSnoozePickerOpen: boolean
  isConvertNoteDialogOpen: boolean
  isLinkNoteModalOpen: boolean
  isDeleteConfirmOpen: boolean

  // Filing workflow
  filingDestination: Folder | null
  filingTags: string[]
  filingOptions: { keepInInbox: boolean; createLink: boolean }

  // UI
  isLoading: boolean
  error: string | null
}
```

---

## 📡 API Endpoints Needed

| Endpoint                        | Method | Purpose                           |
| ------------------------------- | ------ | --------------------------------- |
| `/api/inbox/file`               | POST   | File item to folder               |
| `/api/inbox/convert-to-note`    | POST   | Convert item to markdown note     |
| `/api/inbox/link-to-note`       | POST   | Create reference to existing note |
| `/api/inbox/snooze`             | POST   | Snooze item until later           |
| `/api/inbox/:itemId`            | DELETE | Delete item permanently           |
| `/api/vault/folders`            | GET    | Get folder tree structure         |
| `/api/inbox/filing-suggestions` | POST   | AI suggestions (optional)         |

---

## ✅ MVP Checklist (Phase 1)

- [ ] Detail panel displays items correctly
- [ ] All 7 preview types render properly
- [ ] File to folder (single + bulk) works
- [ ] Convert to note creates markdown file
- [ ] Delete with confirmation works
- [ ] Folder tree displays without lag (1000+ folders)
- [ ] Tags preserved through operations
- [ ] Success/error toasts appear
- [ ] Responsive layout
- [ ] Keyboard navigation (Tab, Escape, Enter)

---

## 🎯 Advanced Features (Phase 2+)

- Smart filing suggestions (AI-powered)
- Snooze functionality with time picker
- Link to note with bidirectional references
- Bulk tag management
- Filing history & analytics
- Dark/light theme support
- Mobile responsiveness

---

## 🚨 Important Notes for Implementation

1. **Folder Tree Performance**
   - Virtualize long folder lists
   - Implement incremental search
   - Handle 1000+ folders without lag

2. **Data Integrity**
   - Never lose items during filing
   - Create filing history records
   - Preserve all metadata

3. **Error Handling**
   - Handle missing destinations gracefully
   - Show clear error messages
   - Provide retry mechanisms

4. **Accessibility**
   - All actions keyboard-accessible
   - Screen reader friendly
   - Clear focus indicators
   - Proper ARIA labels

5. **Real Integration**
   - Connect to actual vault structure
   - Use real note database
   - Implement proper file system operations

---

## 📊 Success Metrics

**Performance**

- Filing completes in <5 seconds
- Folder tree renders in <1 second
- Smart suggestions appear in <1 second

**UX**

- Users can file 10 items in <30 seconds total
- 95% of filing operations complete successfully
- Zero data loss during filing

**Quality**

- No console errors
- Keyboard navigation fully functional
- All accessibility checks passing
- Dark/light mode working

---

## 🔗 Related Components

This Filing Page works with:

- **Inbox List View**: Shows items to select
- **Capture Input**: Creates inbox items
- **Note Editor**: Opens newly created notes
- **Folder View**: Destination for filed items
- **Tab System**: Manages open items

---

## 💡 Implementation Tips

1. **Start Simple**: Build single-item filing first
2. **Add Incrementally**: Then bulk, then advanced features
3. **Test Thoroughly**: Edge cases, errors, permissions
4. **Polish Last**: Animations and visual refinements
5. **Iterate**: Get user feedback early

---

## 📚 What's Included in Full Prompt

✅ Component specifications (1:1 ASCII layouts)
✅ All 8 modals/panels detailed
✅ 5 complete user workflows
✅ Data flow diagrams
✅ Color scheme & typography
✅ Accessibility requirements
✅ Edge cases to handle
✅ Testing scenarios
✅ Implementation phases
✅ Success criteria

---

## 🎬 How to Use This in Lovable

### Option 1: Full Specification (Recommended)

1. Paste entire `LOVABLE_INBOX_FILING_PROMPT.md` into Lovable
2. Ask: "Build the Inbox Filing feature exactly as specified"
3. Provide feedback iteratively
4. Lovable will build component by component

### Option 2: Incremental Building

1. Start with "Build the Inbox Detail Panel component"
2. Then: "Add the Filing Panel modal"
3. Then: "Implement File to Folder functionality"
4. Continue incrementally

### Option 3: Integration Mode

1. Paste prompt into existing Lovable project
2. Ask: "Integrate Inbox Filing into the existing app"
3. Reference the layout and data structures
4. Build with existing components/styling

---

## 🎯 Expected Output

After implementing this specification, you'll have:

✅ **Fully functional inbox filing system**
✅ **7 different content preview types**
✅ **4 filing actions** (folder, note, link, snooze)
✅ **Bulk operations** for multiple items
✅ **Smart folder suggestions**
✅ **Keyboard-accessible interface**
✅ **Professional animations**
✅ **Error handling & recovery**
✅ **Complete data persistence**

---

## 📞 Questions for Lovable?

If Lovable asks clarifying questions:

- Show the specific section in the prompt
- Provide the ASCII diagram for layout reference
- Reference specific user workflow
- Mention the success criteria

---

**Total Specification**: ~2000 lines with layouts, workflows, code examples, and success criteria.

**Estimated Build Time in Lovable**: 2-4 hours (depending on reuse of existing components)

**Complexity**: Medium-High (7 modals, 8 item types, complex state, animations)

Good luck building! 🚀
