import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'en-US',
  title: 'memrynote Docs',
  description: 'Documentation for memrynote, a private offline-first workspace.',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#111827' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
  ],
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'memrynote Docs',
    nav: [
      { text: 'Install', link: '/guide/install' },
      { text: 'User Guide', link: '/user-guide/notes/editing' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Contribute', link: '/contributing' },
      { text: 'GitHub', link: 'https://github.com/memrynote/memry' }
    ],
    sidebar: unifiedSidebar(),
    search: {
      provider: 'local'
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/memrynote/memry' }],
    editLink: {
      pattern: 'https://github.com/memrynote/memry/edit/main/apps/docs/src/:path',
      text: 'Edit this page on GitHub'
    },
    footer: {
      message: 'Released under the GNU GPL v3.0.',
      copyright: 'Copyright © 2026-present memrynote'
    },
    outline: {
      level: [2, 3]
    }
  }
})

function unifiedSidebar() {
  return [
    {
      text: 'Start Here',
      collapsed: false,
      items: [
        { text: 'Install memrynote', link: '/guide/install' },
        { text: 'First Run & Vault Setup', link: '/guide/first-run' },
        { text: 'A Tour of memrynote', link: '/guide/tour' }
      ]
    },
    {
      text: 'User Guide',
      collapsed: false,
      items: [
        { text: 'Importing Notes', link: '/user-guide/import' },
        {
          text: 'Notes',
          collapsed: true,
          items: [
            { text: 'Creating & Editing', link: '/user-guide/notes/editing' },
            { text: 'Wiki Links & Backlinks', link: '/user-guide/notes/wiki-links' },
            { text: 'Properties & Tags', link: '/user-guide/notes/properties-tags' },
            { text: 'Attachments', link: '/user-guide/notes/attachments' },
            { text: 'Custom Icons', link: '/user-guide/notes/custom-icons' },
            { text: 'Bookmarks & Reminders', link: '/user-guide/notes/bookmarks-reminders' },
            { text: 'Find in Page', link: '/user-guide/notes/find-in-page' },
            { text: 'Version History', link: '/user-guide/notes/version-history' }
          ]
        },
        {
          text: 'Journal',
          collapsed: true,
          items: [
            { text: 'Daily Entries', link: '/user-guide/journal/daily-entries' },
            { text: 'Calendar Navigation', link: '/user-guide/journal/calendar-navigation' },
            { text: 'Templates & Settings', link: '/user-guide/journal/templates-settings' }
          ]
        },
        {
          text: 'Tasks',
          collapsed: true,
          items: [
            { text: 'Capturing Tasks', link: '/user-guide/tasks/capturing' },
            { text: 'List vs Kanban', link: '/user-guide/tasks/list-vs-kanban' },
            { text: 'Filters & Sorting', link: '/user-guide/tasks/filters-sorting' },
            { text: 'Subtasks & Recurrence', link: '/user-guide/tasks/subtasks-recurrence' },
            { text: 'Bulk Actions', link: '/user-guide/tasks/bulk-actions' },
            { text: 'Activity Log', link: '/user-guide/tasks/activity-log' },
            { text: 'Drag & Drop', link: '/user-guide/tasks/drag-and-drop' },
            { text: 'Import from Todoist', link: '/user-guide/tasks/import-todoist' },
            { text: 'Import from TickTick', link: '/user-guide/tasks/import-ticktick' }
          ]
        },
        {
          text: 'Inbox',
          collapsed: true,
          items: [
            { text: 'Capturing to Inbox', link: '/user-guide/inbox/capturing' },
            { text: 'Triage Mode', link: '/user-guide/inbox/triage' },
            { text: 'Daily Review Reminder', link: '/user-guide/inbox/review-reminder' },
            { text: 'Filters & Views', link: '/user-guide/inbox/filters' },
            { text: 'Snooze & Archive', link: '/user-guide/inbox/snooze-archive' },
            { text: 'Health', link: '/user-guide/inbox/health' }
          ]
        },
        {
          text: 'Canvas',
          collapsed: true,
          items: [
            { text: 'Overview', link: '/user-guide/canvas/overview' },
            { text: 'Organizing Canvases', link: '/user-guide/canvas/organizing' },
            { text: 'Cards & Links', link: '/user-guide/canvas/cards-and-links' },
            { text: 'Sync & Limits', link: '/user-guide/canvas/sync-and-limits' }
          ]
        },
        {
          text: 'Workspace',
          collapsed: true,
          items: [
            { text: 'Home Dashboard', link: '/user-guide/home-dashboard' },
            { text: 'Projects', link: '/user-guide/projects' },
            { text: 'Calendar', link: '/user-guide/calendar' },
            { text: 'Search & Command Palette', link: '/user-guide/search' },
            { text: 'Command Line', link: '/user-guide/cli' },
            { text: 'Templates', link: '/user-guide/templates' },
            { text: 'Tabs & Split View', link: '/user-guide/tabs-split-view' },
            { text: 'Folder View', link: '/user-guide/folder-view' },
            { text: 'Day Panel', link: '/user-guide/day-panel' },
            { text: 'Snooze & Reminders', link: '/user-guide/snooze-reminders' }
          ]
        },
        {
          text: 'AI Features',
          collapsed: true,
          items: [
            { text: 'Inline AI Menu', link: '/user-guide/ai/inline-menu' },
            { text: 'Embeddings & Semantic Search', link: '/user-guide/ai/embeddings-search' },
            { text: 'Agent Chat & MCP Server', link: '/user-guide/ai/agent-mcp' },
            { text: 'Voice Transcription', link: '/user-guide/ai/voice-transcription' },
            { text: 'Provider Setup', link: '/user-guide/ai/provider-setup' }
          ]
        },
        {
          text: 'Sync & Devices',
          collapsed: true,
          items: [
            { text: 'How Sync Works', link: '/user-guide/sync/how-sync-works' },
            { text: 'Linking Another Device', link: '/user-guide/sync/linking-devices' },
            { text: 'Account on the Web', link: '/user-guide/sync/web-account' },
            { text: 'Recovery Key & Rotation', link: '/user-guide/sync/recovery-rotation' },
            { text: 'Conflict & Health', link: '/user-guide/sync/conflict-health' }
          ]
        },
        {
          text: 'Reference',
          collapsed: true,
          items: [
            { text: 'Settings Reference', link: '/user-guide/settings' },
            { text: 'CLI Reference', link: '/user-guide/cli-reference' },
            { text: 'Menu Bar', link: '/user-guide/menu-bar' },
            { text: 'Keyboard Shortcuts', link: '/user-guide/keyboard-shortcuts' }
          ]
        }
      ]
    },
    {
      text: 'Architecture',
      collapsed: true,
      items: [
        { text: 'Overview', link: '/architecture' },
        { text: 'Monorepo Layout', link: '/architecture/monorepo' },
        { text: 'Local Storage (Dual SQLite)', link: '/architecture/local-storage' },
        { text: 'IPC Boundary', link: '/architecture/ipc' },
        { text: 'CRDT & Notes Sync', link: '/architecture/crdt' },
        { text: 'Sync Protocol', link: '/architecture/sync-protocol' },
        { text: 'Cryptography', link: '/architecture/cryptography' },
        { text: 'Sync Item Handlers', link: '/architecture/sync-handlers' },
        { text: 'Observability & Telemetry', link: '/architecture/observability' }
      ]
    },
    {
      text: 'Contribute',
      collapsed: true,
      items: [
        { text: 'Setting Up', link: '/contributing' },
        { text: 'Repo Workflow', link: '/contribute/workflow' },
        { text: 'Testing', link: '/contribute/testing' },
        { text: 'Common Gotchas', link: '/contribute/gotchas' }
      ]
    },
    {
      text: 'Project',
      collapsed: true,
      items: [
        { text: 'Features Overview', link: '/features' },
        { text: 'Roadmap', link: '/roadmap' }
      ]
    }
  ]
}
