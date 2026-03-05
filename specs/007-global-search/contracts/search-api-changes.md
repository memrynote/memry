# Search API Contract Changes

**Target file**: `src/shared/contracts/search-api.ts`

## New Type: SearchResultInbox

```typescript
export interface SearchResultInbox {
  type: 'inbox'
  id: string
  title: string
  snippet: string | null
  score: number
  matchedIn: ('title' | 'content' | 'transcription')[]
  itemType: 'link' | 'note' | 'image' | 'voice' | 'video' | 'clip' | 'pdf' | 'social' | 'reminder'
  sourceUrl: string | null
  createdAt: string
  filedAt: string | null
}
```

## Modified: SearchResult Union

```diff
-export type SearchResult = SearchResultNote | SearchResultTask | SearchResultJournal
+export type SearchResult = SearchResultNote | SearchResultTask | SearchResultJournal | SearchResultInbox
```

## Modified: SearchQuerySchema

```diff
 export const SearchQuerySchema = z.object({
   query: z.string().min(1).max(500),
-  types: z.array(z.enum(['note', 'task', 'journal'])).default(['note', 'task', 'journal']),
+  types: z.array(z.enum(['note', 'task', 'journal', 'inbox'])).default(['note', 'task', 'journal', 'inbox']),
   // rest unchanged
 })
```

## Modified: QuickSearchResponse

```diff
 export interface QuickSearchResponse {
   notes: SearchResultNote[]
   tasks: SearchResultTask[]
+  journals: SearchResultJournal[]
+  inbox: SearchResultInbox[]
 }
```

## Modified: SearchStats

```diff
 export interface SearchStats {
   totalNotes: number
   totalTasks: number
   totalJournals: number
+  totalInbox: number
   lastIndexed: string
   indexHealth: 'healthy' | 'rebuilding' | 'corrupt'
 }
```

## Modified: IndexRebuildCompletedEvent

```diff
 export interface IndexRebuildCompletedEvent {
   duration: number
   notesIndexed: number
   tasksIndexed: number
+  journalsIndexed: number
+  inboxIndexed: number
 }
```

## Modified: AdvancedSearchSchema

Extend to support multi-type results (currently returns `SearchResultNote[]` only):

```diff
 export const AdvancedSearchSchema = z.object({
   text: z.string().max(500).default(''),
+  types: z.array(z.enum(['note', 'task', 'journal', 'inbox']))
+    .default(['note', 'task', 'journal', 'inbox']),
   operators: SearchOperatorsSchema.optional(),
   titleOnly: z.boolean().default(false),
   sortBy: z.enum(['relevance', 'modified', 'created', 'title']).default('modified'),
   sortDirection: z.enum(['asc', 'desc']).default('desc'),
   folder: z.string().optional(),
+  projectId: z.string().optional(),
   dateFrom: z.string().optional(),
   dateTo: z.string().optional(),
   limit: z.number().int().min(1).max(100).default(50),
   offset: z.number().int().min(0).default(0)
 })
```

## Modified: Handler Signatures

```diff
 [SearchChannels.invoke.ADVANCED_SEARCH]: (
   input: z.infer<typeof AdvancedSearchSchema>
-) => Promise<SearchResultNote[]>
+) => Promise<SearchResponse>
```

## New IPC Channel: SEARCH_INBOX

Already partially defined — `SEARCH_TASKS` exists but isn't implemented. Add inbox equivalent:

```typescript
SEARCH_INBOX: 'search:inbox',
```

## Preload Bridge Additions

New channels to expose in `window.api.search`:

- `searchInbox(query, options)` → `SearchResultInbox[]`
- Update `quick()` return type to include `journals` + `inbox`

## Renderer Service Updates

`src/renderer/src/services/search-service.ts`:

- Add `searchInbox()` method
- Update `quickSearch()` return type
- Update result type guards for inbox items
