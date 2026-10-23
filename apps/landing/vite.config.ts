import { defineConfig, loadEnv, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

function loadApiEnv(mode: string) {
  const env = loadEnv(mode, __dirname, '')

  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value
  }
}

function apiDevProxy(): PluginOption {
  return {
    name: 'api-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const pathName = req.url?.split('?')[0]?.replace(/^\/api\//, '/')
        const apiName = pathName?.match(/^\/([a-z0-9-]+)$/)?.[1]

        if (!apiName) {
          next()
          return
        }

        let body: unknown
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)

          const rawBody = Buffer.concat(chunks).toString()
          body = rawBody ? JSON.parse(rawBody) : undefined
        }

        const mod = await server.ssrLoadModule(`/api/${apiName}.ts`)
        const vercelReq = { method: req.method, body } as never
        const result = {
          statusCode: 200,
          body: '' as string,
          headers: {} as Record<string, number | string | readonly string[]>
        }
        const vercelRes = {
          status(code: number) {
            result.statusCode = code
            return this
          },
          setHeader(name: string, value: number | string | readonly string[]) {
            result.headers[name] = value
            return this
          },
          json(data: unknown) {
            result.body = JSON.stringify(data)
            return this
          }
        } as never

        await mod.default(vercelReq, vercelRes)

        res.statusCode = result.statusCode
        for (const [name, value] of Object.entries(result.headers)) {
          res.setHeader(name, value)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(result.body)
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  loadApiEnv(mode)

  return {
    plugins: [react(), tailwindcss(), apiDevProxy()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    },
    define: {
      // Vite only exposes VITE_-prefixed vars; forward Vercel's build-time
      // VERCEL_ENV ('production' | 'preview' | 'development') so the app can
      // tell real production apart from preview deploys, which `MODE` cannot.
      'import.meta.env.VITE_VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV ?? '')
    },
    build: {
      // scripts/prerender.ts reads this to emit <link rel="modulepreload"> for the boot
      // chunk and its dependencies. main.tsx imports boot dynamically, so Vite has no
      // static entry graph to write those links from, and without them the whole app
      // would only start downloading after the first paint.
      manifest: true,
      rollupOptions: {
        output: {
          // Split heavy vendors into separately-cacheable chunks, so a deploy that
          // only touches app code reuses them from the immutable cache (see
          // vercel.json). posthog, paddle and crypto are reached through dynamic
          // import() at their call sites, so grouping them here keeps them as
          // named chunks while leaving them out of the entry graph entirely.
          // react-vendor, motion and icons stay static: they render first paint.
          manualChunks: {
            // react-dom/client, not the react-dom entry, is what the app imports, and
            // a bare 'react-dom' id here never matched it — the whole renderer was
            // landing in the app chunk and being re-downloaded on every deploy.
            'react-vendor': ['react', 'react-dom', 'react-dom/client', 'react-router'],
            motion: ['motion/react', 'lenis'],
            paddle: ['@paddle/paddle-js'],
            // Must stay the module.full.no-external subpath: the bare specifier
            // resolves to the lean bundle that lazy-loads rrweb as an external
            // script, which disable_external_dependency_loading blocks, silently
            // killing session replay. See src/lib/analytics.ts.
            posthog: ['posthog-js/dist/module.full.no-external'],
            crypto: ['libsodium-wrappers-sumo'],
            icons: ['lucide-react', '@hugeicons/react', '@hugeicons/core-free-icons']
          }
        }
      }
    }
  }
})
