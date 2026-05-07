import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'en-US',
  title: 'Memry Docs',
  description: 'Documentation for Memry, a private offline-first workspace.',
  cleanUrls: true,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#111827' }]],
  themeConfig: {
    siteTitle: 'Memry Docs',
    nav: [
      { text: 'Guide', link: '/guide/install' },
      { text: 'Features', link: '/features' },
      { text: 'Contribute', link: '/contributing' },
      { text: 'GitHub', link: 'https://github.com/memrynote/memry' }
    ],
    sidebar: [
      {
        text: 'Start Here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Install Memry', link: '/guide/install' },
          { text: 'Features', link: '/features' }
        ]
      },
      {
        text: 'Project',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Contributing', link: '/contributing' },
          { text: 'Roadmap', link: '/roadmap' }
        ]
      }
    ],
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
      copyright: 'Copyright © 2026-present Memry'
    },
    outline: {
      level: [2, 3]
    }
  }
})
