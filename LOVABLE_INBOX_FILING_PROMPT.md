# Inbox Filing Page - Lovable.dev Detailed Specification

## Overview

The **Inbox Filing Page** is where users process their captured items by filing them into folders, converting them to full notes, or deleting them. It's a critical component of the capture-process-file workflow that keeps the inbox manageable and transforms quick captures into organized knowledge.

## Page Layout & Architecture

### Overall Structure

```
┌─────────────────────────────────────────────────────┐
│                    Memry App Shell                   │
├─────────────────────────────────────────────────────┤
│ Sidebar   │                                          │
│ - Inbox   │  ┌────────────────────────────────────┐ │
│ - Notes   │  │   INBOX FILING PAGE                │ │
│ - Journal │  │                                    │ │
│ - Tasks   │  │  [Detail Panel for Selected Item]  │ │
│ - ...     │  │                                    │ │
│           │  │  Filing Actions:                   │ │
│           │  │  [ File to Folder ] [ New Note ]   │ │
│           │  │  [ Link to Note ] [ Delete ]       │ │
│           │  │                                    │ │
│           │  │  ┌──────────────────────────────┐ │ │
│           │  │  │  Filing Panel (Modal/Sheet)  │ │ │
│           │  │  │  - Folder selector           │ │ │
│           │  │  │  - Suggestions               │ │ │
│           │  │  │  - Preview                   │ │ │
│           │  │  │  - Filing options            │ │ │
│           │  │  └──────────────────────────────┘ │ │
│           │  │                                    │ │
│           │  └────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│            Status Bar (Bulk Actions)                │
└─────────────────────────────────────────────────────┘
```

---

## Detailed Component Specifications

### 1. **Inbox Detail Panel** (Main Content Area)

**Purpose**: Display full preview and actions for the selected inbox item

#### Layout

```
┌─────────────────────────────────────────┐
│ Item Type Indicator  [More Menu ⋮]     │
├─────────────────────────────────────────┤
│ Title (editable)                        │
├─────────────────────────────────────────┤
│                                         │
│  CONTENT PREVIEW AREA                   │
│  (Type-specific rendering)              │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ Tags:  [tag1] [tag2] [+]                │
├─────────────────────────────────────────┤
│ Primary Actions:                        │
│ [ File to Folder ] [ Convert to Note ]  │
│ [ Link to Note ] [ Snooze ]             │
│                                         │
│ Danger Zone:                            │
│ [ Delete ]                              │
├─────────────────────────────────────────┤
│ Info:                                   │
│ Captured: Jan 10, 2025 • 2:34 PM       │
│ Source: https://example.com/article    │
└─────────────────────────────────────────┘
```

#### Components

**Item Type Indicator**

- Small badge showing item type with icon
- Text label: "Link", "Note", "Image", "Voice", "Clip", "PDF", "Social"
- Color-coded: different color per type (link=blue, note=gray, image=purple, etc.)

**Title Display**

- Show item title prominently
- For notes: show first line if no title
- For links: show webpage title
- For images: show "Image" + dimensions if available
- For PDFs: show PDF title or filename
- For social: show author handle + condensed post text
- Title is NOT editable in filing view (edit happens after filing)

**Content Preview** (Type-specific rendering):

1. **Link Preview**

   ```
   ┌──────────────────────┐
   │  [Hero Image]        │
   ├──────────────────────┤
   │ Domain Icon  Site Name
   │
   │ Description excerpt...
   │ "The user-centered approach..."
   │
   │ Original URL:
   │ https://example.com/article
   │
   │ Metadata:
   │ Author: Jane Doe
   │ Published: Dec 15, 2024
   └──────────────────────┘
   ```

2. **Text Note Preview**

   ```
   ┌──────────────────────┐
   │ Quick note content   │
   │ rendered with        │
   │ markdown formatted   │
   │                      │
   │ - Supports lists     │
   │ - **Bold text**      │
   │ - `code blocks`      │
   │                      │
   │ Max 300px height,    │
   │ scrollable if longer │
   └──────────────────────┘
   ```

3. **Image Preview**

   ```
   ┌──────────────────────┐
   │                      │
   │   [Image Thumbnail]  │
   │   (max 300px)        │
   │                      │
   │ Format: PNG          │
   │ Size: 1920x1080      │
   │ File: 234 KB         │
   └──────────────────────┘
   ```

4. **Voice Memo Preview**

   ```
   ┌──────────────────────┐
   │ ▶  [Audio Player]    │
   │    Duration: 1:34    │
   │                      │
   │ Transcription:       │
   │ "Remember to ask     │
   │  about the API       │
   │  architecture..."    │
   │                      │
   │ Format: WebM         │
   │ Size: 245 KB         │
   └──────────────────────┘
   ```

5. **PDF Preview**

   ```
   ┌──────────────────────┐
   │  [PDF Thumbnail]     │
   │  (Page 1)            │
   ├──────────────────────┤
   │ Pages: 156           │
   │ Size: 8.2 MB         │
   │ Author: InVision     │
   │                      │
   │ Text excerpt:        │
   │ "Design systems are  │
   │  a collection of..." │
   └──────────────────────┘
   ```

6. **Web Clip Preview**

   ```
   ┌──────────────────────┐
   │ " Quoted Text        │
   │   from source        │
   │   displayed as       │
   │   a block quote "    │
   │                      │
   │ — Source: Page Title │
   │   https://example..  │
   │                      │
   │ Captured images: 2   │
   └──────────────────────┘
   ```

7. **Social Post Preview**
   ```
   ┌──────────────────────┐
   │ [Avatar] @handle    │
   │ Jane Doe             │
   │                      │
   │ Great article about  │
   │ design systems!      │
   │ Highly recommend it  │
   │                      │
   │ [Image Preview]      │
   │                      │
   │ ♥ 234 ↻ 45 💬 12   │
   │                      │
   │ 2:34 PM • Jan 10     │
   └──────────────────────┘
   ```

**Tags Row**

- Show existing tags as removable chips
- Add button "+" to add more tags
- On click, show tag input with autocomplete
- Autocomplete suggests existing tags used in filed items
- Allow creating new tags on the fly
- Visual: gray background chips with X to remove

**Primary Action Buttons** (4 options, one per row or grouped)

1. **File to Folder**
   - Icon: FolderArrowDown or similar
   - Text: "File to Folder"
   - Opens Filing Panel (Sheet/Modal)
   - Function: Move item to folder, remove from inbox

2. **Convert to Note**
   - Icon: FileText or Plus
   - Text: "Convert to Note"
   - Creates a new full markdown note
   - Item content becomes note content
   - Tags preserved
   - Links/metadata added as frontmatter
   - Item removed from inbox

3. **Link to Note**
   - Icon: Link
   - Text: "Link to Note"
   - Opens note selector modal
   - User can search/select existing note
   - Item stays in inbox (optional: can mark as linked)
   - Creates bidirectional reference

4. **Snooze**
   - Icon: Clock
   - Text: "Snooze"
   - Opens snooze picker
   - Options: Later Today, Tomorrow, Next Week, Custom Date
   - Item hidden until snooze time
   - Can be accessed in "Snoozed" view

5. **Delete**
   - Icon: Trash
   - Text: "Delete" (in danger zone styling)
   - Color: Red/warning
   - Action: Opens confirmation dialog
   - "Are you sure? This cannot be undone."
   - Permanently removes item from inbox

**Info Section**

- Show metadata:
  - **Captured**: Timestamp of creation
  - **Source**: Original URL (for links, clips, social)
  - **Processing Status**: If still fetching/transcribing (show spinner)
  - **Error**: If fetch/transcription failed (show retry button)

---

### 2. **Filing Panel** (Modal/Sheet)

**Purpose**: Select destination and options for filing an item

**Appears when**: User clicks "File to Folder" or bulk file action

#### Layout

```
┌────────────────────────────────────────┐
│ FILE ITEM TO FOLDER                  ✕ │
├────────────────────────────────────────┤
│                                        │
│ Item Preview (compact):                │
│ [Icon] Document Title                  │
│                                        │
├────────────────────────────────────────┤
│ Select Destination:                    │
│                                        │
│ [ Suggested Folders ]                  │
│  • /Projects/Research  (5 similar)     │
│  • /Archive            (3 similar)     │
│  • /2025/January       (1 similar)     │
│                                        │
│ Browse All Folders:                    │
│ ┌──────────────────────────────────┐   │
│ │ ▶ Notes (root)                   │   │
│ │   ▼ Projects                      │   │
│ │     ▼ Research                    │   │
│ │       - Article 1.md              │   │
│ │       - Article 2.md              │   │
│ │     - Design                      │   │
│ │   ▼ Archive                       │   │
│ │   ▼ 2025                          │   │
│ │     ▼ January                     │   │
│ └──────────────────────────────────┘   │
│                                        │
│ Destination: /Projects/Research        │
│                                        │
├────────────────────────────────────────┤
│ Tags to add:                           │
│ [research] [articles] [x]              │
│ [ + Add tag ]                          │
│                                        │
├────────────────────────────────────────┤
│ Filing Options:                        │
│ ☐ Keep a copy in inbox                │
│ ☐ Create link back to filed item      │
│                                        │
├────────────────────────────────────────┤
│          [ Cancel ]  [ File Item ]     │
└────────────────────────────────────────┘
```

#### Components

**Item Preview (Compact)**

- Show icon + title
- Thumbnail if image/PDF
- Dimensions: ~60px height

**Smart Suggestions** (Optional but highly valuable)

- Show 2-3 suggested folders based on content
- Use filing history + similarity matching
- Display reasoning: "5 similar items filed here"
- Click suggestion to auto-select
- If no suggestions, show message "No suggestions, browse folders below"

**Folder Selector**

- Tree view of vault folders
- Expandable/collapsible folder structure
- Show folder icons
- Highlight selected folder
- Support search/filter: as you type, filter folder list
- Keyboard navigation: arrow keys to navigate, Enter to select
- Visual indicators:
  - Bold/highlighted: currently selected
  - Indentation: folder hierarchy
  - Icon: different for folder vs file

**Tags Input**

- Show tags that will be applied on filing
- Chips with X to remove
- "+ Add tag" button to add new
- Autocomplete from existing tags
- Create new tag on Enter

**Filing Options (Checkboxes)**

- "Keep a copy in inbox": If checked, don't remove item from inbox after filing
- "Create link back to filed item": If checked, file creates bidirectional link

**Action Buttons**

- [ Cancel ] - Close without filing
- [ File Item ] - Execute filing, show success toast, close

---

### 3. **Bulk Filing Panel** (For Multiple Items)

**Purpose**: File multiple selected items at once

#### Differences from Single Item Panel

```
┌────────────────────────────────────────┐
│ FILE 5 ITEMS TO FOLDER               ✕ │
├────────────────────────────────────────┤
│                                        │
│ Items to file:                         │
│ □ [Link Icon] Article on Design        │
│ □ [Note Icon] Quick Note about UX      │
│ □ [Image Icon] Screenshot              │
│ □ [Voice Icon] Voice memo (1:34)       │
│ □ [PDF Icon] Research Paper            │
│                                        │
├────────────────────────────────────────┤
│ [Rest same as single item panel]       │
│                                        │
│ Filing Options:                        │
│ ☐ Keep copies in inbox                │
│ ☐ Create links back to filed items    │
│                                        │
├────────────────────────────────────────┤
│          [ Cancel ]  [ File 5 Items ]  │
└────────────────────────────────────────┘
```

- Show count: "FILE 5 ITEMS TO FOLDER"
- List all items with type icons and titles
- Scrollable if many items
- Same folder selector and tags workflow
- Options apply to all items

---

### 4. **Snooze Picker** (Modal/Popover)

**Purpose**: Select when to resurface a snoozed item

#### Layout

```
┌──────────────────────────┐
│ REMIND ME LATER          │
├──────────────────────────┤
│                          │
│ [ Later Today ]          │
│ [ Tomorrow ]             │
│ [ Next Week ]            │
│ [ Next Month ]           │
│ [ Custom Date/Time ]     │
│                          │
├──────────────────────────┤
│ Reason (optional):       │
│ [________________]       │
│ e.g., "Need to read..."  │
│                          │
├──────────────────────────┤
│    [ Cancel ] [ Snooze ] │
└──────────────────────────┘
```

**Components**

- **Quick Options**: Buttons for common snooze times
  - Later Today: 4 hours from now
  - Tomorrow: 9 AM next day
  - Next Week: 7 days from now
  - Next Month: 30 days from now

- **Custom Date/Time**: Opens date picker
  - Calendar widget
  - Time selector (hour + minute)
  - Set custom exact time

- **Optional Reason**: Text input
  - User can note why they snoozed
  - Displayed in history/logs

---

### 5. **Conversion to Note Dialog** (Modal)

**Purpose**: Confirm and configure conversion of inbox item to full note

#### Layout

```
┌────────────────────────────────────────┐
│ CONVERT TO NOTE                      ✕ │
├────────────────────────────────────────┤
│ This will create a new note in your    │
│ vault with the item's content.         │
│                                        │
│ Note Title:                            │
│ [Document Title or "Untitled Note"  ] │
│                                        │
│ Location:                              │
│ [Notes (root)  ▼]                     │
│ (folder selector)                      │
│                                        │
│ Include:                               │
│ ☑ Item content                         │
│ ☑ Tags                                 │
│ ☑ Source link/metadata as frontmatter  │
│ ☑ Item attachments (images, PDFs)      │
│                                        │
│ After conversion:                      │
│ ☐ Delete from inbox                    │
│                                        │
├────────────────────────────────────────┤
│      [ Cancel ] [ Create Note ]        │
└────────────────────────────────────────┘
```

**Components**

- **Title Input**: Pre-filled with item title or filename
- **Location Selector**: Choose folder for new note
- **Include Options**: Checkboxes for what to include
  - Content: main item text/description
  - Tags: preserve tags from inbox
  - Source metadata: URL, author, date as frontmatter/properties
  - Attachments: copy image/PDF files to note folder

- **Delete Option**: Option to remove from inbox after conversion
- **Action**: Create Note button triggers creation and closes dialog

---

### 6. **Link to Note Selector** (Modal)

**Purpose**: Search and select existing note to link with inbox item

#### Layout

```
┌────────────────────────────────────────┐
│ LINK TO NOTE                         ✕ │
├────────────────────────────────────────┤
│ Search notes:                          │
│ [Search...                            ]│
│                                        │
│ Recent Notes:                          │
│ • "Notes on Design Systems"            │
│ • "2025-01-10 Journal Entry"           │
│ • "Research Archive"                   │
│                                        │
│ Suggested (similar content):           │
│ • "UI Design Principles"     (match%)  │
│ • "Product Design"           (match%)  │
│                                        │
│ All Notes:                             │
│ ▶ Notes (root)                         │
│   ▼ Projects                           │
│     ▼ Research                         │
│       • "Article Analysis"             │
│     • "UX Patterns"                    │
│   • "Archive"                          │
│                                        │
│ Selected: "Article Analysis"           │
│                                        │
├────────────────────────────────────────┤
│      [ Cancel ] [ Link to Note ]       │
└────────────────────────────────────────┘
```

**Components**

- **Search Input**: Full-text search across all notes
- **Recent Notes**: Quick list of recently modified notes
- **AI Suggestions**: Similar notes based on content matching
- **Tree View**: Browse all notes hierarchically
- **Selection Display**: Show currently selected note
- **Action**: Link button creates reference (item may stay in inbox as linked status)

---

### 7. **Delete Confirmation Dialog** (Modal)

**Purpose**: Confirm item deletion before permanent removal

#### Layout

```
┌──────────────────────────────────────┐
│ DELETE ITEM?                        ✕ │
├──────────────────────────────────────┤
│                                      │
│ ⚠️  Are you sure you want to delete  │
│ this item?                           │
│                                      │
│ "Article on Design Systems"          │
│                                      │
│ This action cannot be undone.        │
│                                      │
│ If you have attachments, they will   │
│ be permanently deleted.              │
│                                      │
│ Type DELETE to confirm:              │
│ [________________]                   │
│                                      │
├──────────────────────────────────────┤
│    [ Cancel ] [ Delete (disabled) ]  │
└──────────────────────────────────────┘
```

**Components**

- **Warning Message**: Clear statement of permanence
- **Item Title**: Show what's being deleted
- **Confirmation Input**: Type "DELETE" to enable button
- **Action Buttons**:
  - Cancel: closes without deleting
  - Delete: only enabled when "DELETE" is typed exactly

---

## User Workflows

### Workflow 1: File Single Item to Folder

1. User views inbox with multiple items
2. Clicks on one item → Detail panel opens
3. Clicks "File to Folder" button
4. Filing Panel opens with folder browser
5. User browses/searches for destination folder
6. (Optional) Adds tags
7. Clicks "File Item" button
8. System:
   - Moves item content to destination folder
   - Creates filing history record
   - Removes item from inbox
   - Shows success toast: "Filed to /Projects/Research"
9. Detail panel closes or shows next item

### Workflow 2: Convert Inbox Item to Full Note

1. User selects item in inbox
2. Clicks "Convert to Note"
3. Conversion dialog opens
4. User:
   - Confirms/edits title
   - Selects location folder
   - Chooses what to include
5. Clicks "Create Note"
6. System:
   - Creates new note file in vault
   - Populates with item content + metadata
   - Creates filing history
   - Removes from inbox
7. Toast: "Note created at /Projects/article.md"
8. (Optional) Opens new note in editor

### Workflow 3: Bulk File Multiple Items

1. User selects multiple items (Cmd+Click, Cmd+A)
2. Bulk action bar appears
3. Clicks "File" or "File Selected"
4. Bulk Filing Panel opens
5. Shows all selected items (scrollable list)
6. User:
   - Selects destination folder
   - Adds tags (applied to all)
   - Reviews filing options
7. Clicks "File 5 Items"
8. System:
   - Files all items to same folder
   - Creates filing history for each
   - Removes all from inbox
9. Toast: "Filed 5 items to /Projects"

### Workflow 4: Snooze Item for Later

1. User clicks item in inbox
2. Clicks "Snooze" button
3. Snooze picker appears
4. User:
   - Clicks "Tomorrow" or selects custom date
   - (Optional) Adds reason note
5. Clicks "Snooze"
6. Item disappears from main inbox view
7. Item appears in "Snoozed" view
8. When snooze time arrives:
   - Item resurfaces at top of inbox
   - Toast notification: "Snoozed item returned"
9. User can now process it

### Workflow 5: Delete Unwanted Item

1. User views item in detail panel
2. Scrolls to "Danger Zone"
3. Clicks "Delete"
4. Delete confirmation dialog appears
5. User types "DELETE" in confirmation box
6. "Delete" button becomes enabled
7. Clicks "Delete"
8. Item permanently removed
9. Toast: "Item deleted"

---

## Bulk Action Bar (Bottom of Screen)

**Appears when**: User has selected one or more items

**Layout**:

```
┌────────────────────────────────────────────────┐
│ [checkbox] 5 items selected   [x]              │
│                                                │
│ [ File ]  [ Tag ]  [ Delete ]  [ More ▼ ]    │
└────────────────────────────────────────────────┘
```

**Components**

- **Selection Count**: "5 items selected"
- **Clear Button (x)**: Deselect all
- **File Button**: Opens bulk filing panel
- **Tag Button**: Bulk add/remove tags
- **Delete Button**: Bulk delete (shows confirmation for all)
- **More Menu**: Additional actions
  - Snooze all
  - Mark as processed
  - Export selected items

---

## Data Flows & State Management

### State to Track

```typescript
// Inbox page state
interface InboxFilingState {
  selectedItems: string[] // IDs of selected inbox items
  selectedItem: InboxItem | null // Currently viewing item

  // Modals/Panels
  isFilingPanelOpen: boolean
  isSnoozePickerOpen: boolean
  isConvertNoteDialogOpen: boolean
  isLinkNoteModalOpen: boolean
  isDeleteConfirmOpen: boolean

  // Filing workflow
  filingDestination: Folder | null
  filingTags: string[]
  filingOptions: {
    keepInInbox: boolean
    createLink: boolean
  }

  // UI states
  isLoading: boolean
  error: string | null
  successMessage: string | null
}
```

### API Interactions

**File Item to Folder**

```
POST /api/inbox/file
{
  itemId: string
  destination: FilingDestination
  tags: string[]
  options: FilingOptions
}
→ { success: true, filedTo: string }
```

**Convert to Note**

```
POST /api/inbox/convert-to-note
{
  itemId: string
  noteTitle: string
  destinationFolder: string
  includeMetadata: boolean
  deleteAfter: boolean
}
→ { success: true, noteId: string, notePath: string }
```

**Link to Note**

```
POST /api/inbox/link-to-note
{
  itemId: string
  noteId: string
}
→ { success: true }
```

**Snooze Item**

```
POST /api/inbox/snooze
{
  itemId: string
  snoozeUntil: ISO8601DateTime
  reason?: string
}
→ { success: true, snoozedUntil: ISO8601DateTime }
```

**Delete Item**

```
DELETE /api/inbox/:itemId
→ { success: true }
```

**Get Folder Structure**

```
GET /api/vault/folders
→ { folders: Folder[] }
```

**Get Filing Suggestions** (Optional AI feature)

```
POST /api/inbox/filing-suggestions
{
  itemId: string
}
→ { suggestions: FilingSuggestion[] }
```

---

## Visual Design & Styling

### Color Scheme

**Item Type Colors** (Badges/Icons)

- Link: Teal/Blue (#0891b2)
- Note: Gray (#64748b)
- Image: Purple (#a855f7)
- Voice: Orange (#f97316)
- Clip: Indigo (#6366f1)
- PDF: Red (#ef4444)
- Social: Sky Blue (#0ea5e9)

**Button States**

- Primary (File, Create Note): Teal background, white text
- Secondary (Cancel, Link): Gray background, dark text
- Danger (Delete): Red background, white text
- Disabled: Gray background, muted text

**Focus/Hover States**

- Slight scale increase (1.02x)
- Shadow elevation increase
- Color intensity increase

### Typography

- **Title**: 18px, bold, dark text
- **Section Heading**: 14px, semibold, medium gray
- **Body**: 14px, regular, dark text
- **Metadata**: 12px, regular, light gray
- **Labels**: 12px, semibold, medium gray

### Spacing

- **Padding**: 16px standard, 8px compact
- **Gap**: 12px between sections
- **Border Radius**: 8px on cards/panels, 6px on buttons
- **Line Height**: 1.5 for readability

### Animations

- **Panel Open/Close**: 300ms slide animation
- **Item Fade**: 200ms opacity transition
- **Button Click**: 150ms scale + shadow pulse
- **Success Toast**: Slide up 400ms, auto-dismiss after 3s

---

## Accessibility

### Keyboard Navigation

- **Tab**: Navigate between buttons/inputs
- **Escape**: Close modal/panel
- **Enter**: Confirm action (File, Delete if confirmed)
- **Arrow Keys**: Navigate folder tree, list items
- **Cmd+A**: Select all items (in list view)
- **Cmd+Click**: Toggle item selection
- **Space**: Toggle checkbox/selection

### Screen Reader

- Button labels clearly describe action: "File to folder", "Delete item"
- Modal headings: "File Item to Folder"
- Status updates: "5 items selected", "Item filed successfully"
- Form labels: "Destination folder", "Tags to add"
- Error messages announced: "Error: Cannot file item, please try again"

### Focus Management

- Focus visible ring on all interactive elements
- Modal traps focus (Tab cycles within modal)
- On close, focus returns to trigger button
- Loading state disables buttons with aria-busy

---

## Success Criteria for Lovable Implementation

✅ **Core Filing Functionality**

- [ ] Single item filing to folder works
- [ ] Bulk filing multiple items works
- [ ] Convert to note creates valid markdown file
- [ ] Link to note creates bidirectional reference

✅ **User Experience**

- [ ] Filing process takes <30 seconds for typical item
- [ ] Folder tree displays 1000+ folders without lag
- [ ] Smart suggestions appear <1 second
- [ ] Success/error toasts display clearly

✅ **Keyboard & Accessibility**

- [ ] All actions accessible via keyboard
- [ ] Screen reader announces all important information
- [ ] Focus management works correctly
- [ ] No console accessibility warnings

✅ **Visual & Polish**

- [ ] Smooth animations throughout
- [ ] Professional appearance matching design intent
- [ ] Mobile-responsive (if applicable)
- [ ] Dark/light theme support
- [ ] No layout shifts or jank

✅ **Data Integrity**

- [ ] No items lost during filing
- [ ] Filing history recorded accurately
- [ ] Tags preserved through operations
- [ ] Metadata extracted correctly

---

## Implementation Priority

### Phase 1 (MVP)

1. Detail Panel display
2. File to Folder (single + bulk)
3. Convert to Note
4. Delete with confirmation
5. Basic styling & layout

### Phase 2 (Enhanced)

1. Snooze functionality
2. Link to Note
3. Smart suggestions
4. Tag management
5. Keyboard navigation

### Phase 3 (Polish)

1. Animation refinements
2. Dark/light theme toggle
3. Accessibility improvements
4. Mobile responsiveness
5. Performance optimization

---

## Notes for Lovable.dev

- This is a **critical workflow feature** - filing is how users keep inbox processed
- **Smart suggestions** (if implemented) significantly improves UX by reducing decision time
- **Keyboard shortcuts** essential for power users who process many items
- **Real data**: Connect to actual vault folder structure and note database
- **Error handling**: Handle cases where folder doesn't exist, file conflicts, permission issues
- **Progressive disclosure**: Show advanced options (filing options, suggestions) only when needed
- **Immediate feedback**: Show loading states, success/error messages, item count updates

---

## Edge Cases to Handle

1. **User files item to folder that no longer exists**
   - Show error: "Destination folder not found"
   - Suggest alternative destinations

2. **User tries to convert note but note title already exists**
   - Auto-suffix: "Article.md" → "Article (1).md"
   - Or prompt user to rename

3. **User tries to link to note but note is deleted**
   - Show error: "Note no longer exists"

4. **Bulk filing partially fails** (e.g., 4 of 5 succeed)
   - Toast: "Filed 4 of 5 items. 1 item failed. Reason: [error]"
   - Keep failed items in inbox for retry

5. **User closes filing panel without filing**
   - No changes saved
   - Item remains in inbox

6. **Network timeout during filing**
   - Show error and retry button
   - Item remains in inbox, unchanged

7. **User tries to file item with no title**
   - Auto-generate title: "Untitled (Jan 10, 2:34 PM)"
   - Or show warning and require user to enter

---

## Component Dependencies

- **UI Library**: Shadcn/ui (Button, Modal, Sheet, Popover, etc.)
- **Icons**: lucide-react
- **State**: React hooks or React Query
- **Form**: React Hook Form or native inputs
- **Validation**: Zod schemas

---

## Testing Scenarios

1. **Happy path**: User files item, sees success, inbox updates
2. **Bulk operations**: Select 5 items, file all to same folder
3. **Conversion**: Convert link to note, verify all metadata included
4. **Error handling**: Network error during filing, retry succeeds
5. **Keyboard**: Full navigation without mouse
6. **Accessibility**: Screen reader announces all actions and states
7. **Performance**: Load inbox with 1000 items, scroll without jank
8. **Edge cases**: File to new folder, convert with no title, link to self
