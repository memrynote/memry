import { inject } from '@vercel/analytics'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h, onMounted } from 'vue'
import './custom.css'
import YouTube from './YouTube.vue'

const VercelAnalytics = {
  name: 'VercelAnalytics',
  setup() {
    onMounted(() => {
      inject({ framework: 'vitepress' })
    })

    return () => null
  }
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('YouTube', YouTube)
  },
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'layout-top': () => h(VercelAnalytics)
    })
  }
} satisfies Theme
