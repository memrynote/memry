import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'

import {
  destroyElectronApp,
  launchElectronWithWindow,
  type LaunchedElectron
} from './utils/electron-lifecycle'
import {
  approveAgentToolCall,
  enableManualAgentToolApproval,
  getAgentComposer,
  openAgentChat,
  selectAgentModel
} from './utils/agent-chat-helpers'
import {
  createNote,
  navigateTo,
  waitForAppReady,
  waitForVaultReady,
  showAllTasksScope
} from './utils/electron-helpers'

const AGENT_TASK_CREATE_TIMEOUT_MS = process.env.CI ? 60_000 : 20_000

test.describe('Agent chat create-task flow', () => {
  let launched: LaunchedElectron | null = null
  let testVaultPath = ''
  let fakeLocalServer: http.Server | null = null

  test.beforeEach(async () => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-agent-e2e-'))
    fs.mkdirSync(path.join(testVaultPath, '.memry'), { recursive: true })
    fs.mkdirSync(path.join(testVaultPath, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(testVaultPath, 'journal'), { recursive: true })

    const stubDir = path.resolve(__dirname, 'fixtures')
    launched = await launchElectronWithWindow({
      testVaultPath,
      extraEnv: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`
      }
    })
  })

  test.afterEach(async () => {
    if (launched) {
      const dirs = [launched.userDataDir]
      if (launched.resolvedUserDataDir !== launched.userDataDir) {
        dirs.push(launched.resolvedUserDataDir)
      }
      await destroyElectronApp(launched.app, dirs)
    }
    if (testVaultPath) {
      fs.rmSync(testVaultPath, { recursive: true, force: true })
    }
    if (fakeLocalServer) {
      await new Promise<void>((resolve) => fakeLocalServer?.close(() => resolve()))
    }
    launched = null
    testVaultPath = ''
    fakeLocalServer = null
  })

  test('creates a task through the approval gate from an active note', async () => {
    if (!launched) throw new Error('Electron app was not launched')
    const { page } = launched

    await waitForAppReady(page)
    await waitForVaultReady(page)
    await createNote(page, 'Agent source note', 'Remember to buy milk after work.')
    await enableManualAgentToolApproval(page)

    await openAgentChat(page)

    const composer = getAgentComposer(page)
    await expect(composer).toBeEnabled()
    await composer.fill('Create a task from the current note')
    await composer.press('Enter')

    await approveAgentToolCall(page, /Creating task.*Awaiting approval/i)

    await expect
      .poll(
        async () => {
          const tasks = await page.evaluate(() => window.api.tasks.list({ limit: 100 }))
          return tasks.tasks.some((task) => task.title === 'Buy milk')
        },
        { timeout: AGENT_TASK_CREATE_TIMEOUT_MS }
      )
      .toBe(true)

    await navigateTo(page, 'tasks')
    await showAllTasksScope(page)
    await expect(page.getByRole('button', { name: 'Task: Buy milk' })).toBeVisible()
  })

  test('creates a task through a fake local OpenAI-compatible server', async () => {
    if (!launched) throw new Error('Electron app was not launched')
    const { page } = launched
    const local = await startFakeLocalOpenAiServer()
    fakeLocalServer = local.server

    await waitForAppReady(page)
    await waitForVaultReady(page)
    await createNote(page, 'Local agent source note', 'Remember to buy milk after work.')
    await enableManualAgentToolApproval(page)
    await page.evaluate(
      ({ baseUrl }) =>
        window.api.agent.setLocalProviderSettings({
          preset: 'custom',
          baseUrl,
          model: 'fake-local',
          allowNonLoopback: false
        }),
      { baseUrl: local.baseUrl }
    )

    await openAgentChat(page)
    // The local backend is picked by picking its model: `fake-local` is the id
    // set on the provider above, and the picker lists it under Local.
    await selectAgentModel(page, 'fake-local', 'fake-local')

    const composer = getAgentComposer(page)
    await expect(composer).toBeEnabled()
    await composer.fill('Create a task from the current note')
    await composer.press('Enter')

    await approveAgentToolCall(page, /Creating task.*Awaiting approval/i)

    await expect
      .poll(
        async () => {
          const tasks = await page.evaluate(() => window.api.tasks.list({ limit: 100 }))
          return tasks.tasks.some((task) => task.title === 'Buy milk')
        },
        { timeout: AGENT_TASK_CREATE_TIMEOUT_MS }
      )
      .toBe(true)
  })
})

async function startFakeLocalOpenAiServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(response, { data: [{ id: 'fake-local' }] })
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(request)
        if (!body.stream) {
          return sendJson(response, completionForProbe(body))
        }
        return sendStream(response, streamChunksFor(body))
      }

      response.writeHead(404)
      response.end()
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('Fake local OpenAI server error')
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` }
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, any>> {
  let body = ''
  for await (const chunk of request) body += chunk
  return body ? JSON.parse(body) : {}
}

function completionForProbe(body: Record<string, any>): Record<string, unknown> {
  if (Array.isArray(body.tools)) {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'probe-1',
                type: 'function',
                function: { name: 'memry_probe_echo', arguments: '{"text":"ok"}' }
              }
            ]
          }
        }
      ]
    }
  }

  return { choices: [{ message: { role: 'assistant', content: 'ok' } }] }
}

function streamChunksFor(body: Record<string, any>): Array<Record<string, unknown>> {
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.some((message: Record<string, unknown>) => message.role === 'tool')) {
    return [chunk({ content: 'Created Buy milk.' }), chunk({}, 'stop')]
  }

  const toolNames = Array.isArray(body.tools)
    ? body.tools.map((tool: Record<string, any>) => tool.function?.name)
    : []

  if (toolNames.includes('vault_create_task')) {
    return [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call-create-task',
            type: 'function',
            function: {
              name: 'vault_create_task',
              arguments: JSON.stringify({
                title: 'Buy milk',
                notes: 'Created from the current note.'
              })
            }
          }
        ]
      }),
      chunk({}, 'tool_calls')
    ]
  }

  return [chunk({ content: 'ok' }), chunk({}, 'stop')]
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-local-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-local',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
}

function sendJson(response: http.ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendStream(response: http.ServerResponse, chunks: Array<Record<string, unknown>>): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache'
  })
  for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`)
  response.end('data: [DONE]\n\n')
}
