import { inject } from '@vercel/analytics'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h, onMounted } from 'vue'
import './custom.css'

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
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'layout-top': () => h(VercelAnalytics)
    })
  }
} satisfies Theme
