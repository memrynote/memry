/**
 * Writes the agent MCP contract vectors (Step 28, #3545) that the Rust MCP server is held to
 * while Electron is the oracle, into packages/contracts/test-vectors/agent-mcp/:
 *
 * - tools.json: every tool as Electron's server lists it (`tools/list` of the real SDK server
 *   over `TOOL_SCHEMAS`): name, read or write class, description and input JSON Schema.
 * - desktop-ops.json: every desktop API operation with its tool, parameters and the JSON Schema
 *   of its argument array (`describeDesktopOperation`).
 * - examples.json: the calls of agent-api-examples.json and deterministic invalid variants of
 *   each, with Electron's verdict: for a tool, whether its handler ran, zod's issues and the
 *   SDK's error text; for an operation, the VALIDATION error `assertDesktopApiArgs` throws.
 *
 *   pnpm --filter @memry/desktop vectors:agent-mcp          # write the files
 *   pnpm --filter @memry/desktop vectors:agent-mcp:check    # regenerate in memory, diff, write nothing
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { AgentMcpDesktopOperations } from '@memry/contracts/agent-mcp-channels'
import type { AgentMcpDesktopOperation } from '@memry/contracts/agent-mcp-channels'

import { AgentToolError } from '../src/main/agent/mcp/errors'
import { describeDesktopOperation } from '../src/main/agent/mcp/tools/desktop-api-describe'
import type { DesktopOperationDescription } from '../src/main/agent/mcp/tools/desktop-api-describe'
import { assertDesktopApiArgs } from '../src/main/agent/mcp/tools/desktop-api-params'
import {
  READ_TOOL_NAMES,
  TOOL_SCHEMAS,
  WRITE_TOOL_NAMES,
  type ToolName
} from '../src/main/agent/mcp/tools/schemas'
import type { AgentApiExamples } from './agent-api-reference'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(here, '../../../packages/contracts/test-vectors/agent-mcp')
const EXAMPLES_PATH = path.join(here, 'agent-api-examples.json')
const GENERATOR = 'apps/desktop/scripts/generate-agent-mcp-vectors.ts'

/** A key no tool or operation takes. */
const UNKNOWN_KEY = 'memry_unknown_key'

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as JSON: what crosses the wire, `undefined` dropped. */
function toJson(value: unknown): Json {
  const text = JSON.stringify(value)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse of JSON.stringify output is JSON by construction
  return text === undefined ? null : (JSON.parse(text) as Json)
}

/** A value of another JSON type than `value`. */
function wrongType(value: unknown): Json {
  if (typeof value === 'string') return 42
  if (typeof value === 'number') return 'not a number'
  if (typeof value === 'boolean') return 'true'
  if (Array.isArray(value)) return {}
  if (isObject(value)) return []
  return 42
}

function meta(oracle: string, note: string): JsonObject {
  return {
    generator: GENERATOR,
    oracle,
    note,
    regenerate: 'pnpm --filter @memry/desktop vectors:agent-mcp'
  }
}

const ALL_TOOLS: readonly ToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]
const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES)

function assertEveryToolClassed(): void {
  const classed = new Set<string>(ALL_TOOLS)
  const missing = Object.keys(TOOL_SCHEMAS).filter((name) => !classed.has(name))
  if (missing.length > 0 || classed.size !== ALL_TOOLS.length) {
    throw new Error(`tools with no single read or write class: ${missing.join(', ')}`)
  }
}

interface Oracle {
  client: Client
  /** Names of the tools whose handler ran since the last reset. */
  ran: Set<string>
}

/** Electron's server shape: one McpServer with every tool, its SDK validating each input. */
async function startOracle(): Promise<Oracle> {
  const ran = new Set<string>()
  const server = new McpServer({ name: 'memry-vault', version: '1.0.0' })
  for (const name of ALL_TOOLS) {
    server.registerTool(
      name,
      { description: TOOL_SCHEMAS[name].description, inputSchema: TOOL_SCHEMAS[name].input },
      () => {
        ran.add(name)
        return { content: [{ type: 'text', text: 'null' }] }
      }
    )
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'memry-vectors', version: '1.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return { client, ran }
}

async function toolsFile(oracle: Oracle): Promise<JsonObject> {
  const { tools } = await oracle.client.listTools()
  return {
    meta: meta(
      'apps/desktop/src/main/agent/mcp/tools/schemas.ts (TOOL_SCHEMAS, READ_TOOL_NAMES, WRITE_TOOL_NAMES) listed by @modelcontextprotocol/sdk McpServer tools/list',
      '`inputSchema` is what Electron sends external MCP clients. `class` write means the call needs a turn grant and the user’s approval.'
    ),
    tools: tools.map((tool) => ({
      name: tool.name,
      class: WRITE_TOOLS.has(tool.name) ? 'write' : 'read',
      description: tool.description ?? '',
      inputSchema: toJson(tool.inputSchema)
    }))
  }
}

function describeOperation(operation: AgentMcpDesktopOperation): DesktopOperationDescription {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- describeDesktopOperation returns the full description for a named operation
  return describeDesktopOperation(operation) as DesktopOperationDescription
}

function desktopOpsFile(): JsonObject {
  return {
    meta: meta(
      'apps/desktop/src/main/agent/mcp/tools/desktop-api-describe.ts (describeDesktopOperation) over packages/contracts/src/agent-desktop-api-args.ts',
      '`argsSchema` validates the whole `args` array of vault_desktop_read or vault_desktop_write; desktopArgsItemSchemas reads the per-argument schemas out of its prefixItems.'
    ),
    operations: AgentMcpDesktopOperations.map((operation) => {
      const description = describeOperation(operation)
      const { $schema: _drop, ...argsSchema } = description.args_schema
      return {
        operation,
        tool: description.tool,
        requiresApproval: description.requires_approval,
        call: description.call,
        params: toJson(description.params),
        argsSchema: toJson(argsSchema)
      }
    })
  }
}

/** The example arguments of a tool and invalid variants of them, each named. */
function toolCases(args: JsonObject, inputSchema: Json): Array<[string, JsonObject]> {
  const cases: Array<[string, JsonObject]> = [
    ['example', args],
    ['unknown key', { ...args, [UNKNOWN_KEY]: true }]
  ]
  const required = isObject(inputSchema) && Array.isArray(inputSchema.required)
  for (const key of required && isObject(inputSchema) ? inputSchema.required : []) {
    if (typeof key === 'string' && key in args) {
      const { [key]: _drop, ...rest } = args
      cases.push([`missing ${key}`, rest])
    }
  }
  for (const [key, value] of Object.entries(args)) {
    cases.push([`wrong type ${key}`, { ...args, [key]: wrongType(value) }])
  }
  return cases
}

function replyText(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.content)) return ''
  return result.content
    .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

async function toolExamples(
  oracle: Oracle,
  examples: AgentApiExamples,
  listed: Map<string, Json>
): Promise<Json[]> {
  const out: Json[] = []
  for (const name of ALL_TOOLS) {
    const example = examples.tools[name]
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the examples file holds JSON arguments
    const base = (example ? toJson(example.arguments) : {}) as JsonObject
    for (const [variant, args] of toolCases(base, listed.get(name) ?? null)) {
      oracle.ran.clear()
      const result = await oracle.client.callTool({ name, arguments: args })
      const valid = oracle.ran.has(name)
      const parsed = TOOL_SCHEMAS[name].input.safeParse(args)
      if (parsed.success !== valid) {
        throw new Error(`${name} (${variant}): zod and the SDK disagree`)
      }
      out.push({
        tool: name,
        variant,
        arguments: args,
        valid,
        ...(parsed.success
          ? {}
          : { issues: toJson(parsed.error.issues), errorText: replyText(result) })
      })
    }
  }
  return out
}

/** The example arguments of an operation and invalid variants of them, each named. */
function operationCases(args: Json[], params: string[]): Array<[string, Json[]]> {
  const cases: Array<[string, Json[]]> = [['example', args]]
  const padded = params.map((_, index) => args[index] ?? null)
  cases.push(['extra argument', [...padded, 'extra']])
  if (params.length > 0) {
    cases.push([`wrong type ${params[0]}`, [wrongType(args[0]), ...args.slice(1)]])
    const first = args[0]
    if (isObject(first)) {
      cases.push([
        `unknown key in ${params[0]}`,
        [{ ...first, [UNKNOWN_KEY]: true }, ...args.slice(1)]
      ])
    }
  }
  return cases
}

function operationVerdict(operation: AgentMcpDesktopOperation, args: Json[]): Json {
  try {
    assertDesktopApiArgs({ operation, args })
    return null
  } catch (error) {
    if (!(error instanceof AgentToolError)) throw error
    return toJson({ code: error.code, message: error.message, details: error.details })
  }
}

function operationExamples(examples: AgentApiExamples): Json[] {
  return AgentMcpDesktopOperations.flatMap((operation) => {
    const example = examples.operations[operation]
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the examples file holds JSON arguments
    const base = (example ? toJson(example.args) : []) as Json[]
    const params = describeOperation(operation).params.map((param) => param.name)
    return operationCases(base, params).map(([variant, args]) => {
      const error = operationVerdict(operation, args)
      return { operation, variant, args, valid: error === null, ...(error ? { error } : {}) }
    })
  })
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function build(): Promise<Map<string, string>> {
  assertEveryToolClassed()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- agent-api-examples.json is the AgentApiExamples file agent-api-reference.ts reads
  const examples = JSON.parse(readFileSync(EXAMPLES_PATH, 'utf8')) as AgentApiExamples
  const oracle = await startOracle()
  try {
    const tools = await toolsFile(oracle)
    const listed = new Map<string, Json>()
    for (const tool of Array.isArray(tools.tools) ? tools.tools : []) {
      if (isObject(tool) && typeof tool.name === 'string') listed.set(tool.name, tool.inputSchema)
    }
    const examplesFile = {
      meta: meta(
        'apps/desktop/scripts/agent-api-examples.json run through the SDK server above (tools) and assertDesktopApiArgs (operations)',
        'A tool case is `valid` when Electron ran its handler; otherwise `issues` are zod’s and `errorText` is the reply text the SDK sends. An operation case carries the VALIDATION error Electron returns, or none.'
      ),
      tools: await toolExamples(oracle, examples, listed),
      operations: operationExamples(examples)
    }
    return new Map([
      ['tools.json', render(tools)],
      ['desktop-ops.json', render(desktopOpsFile())],
      ['examples.json', render(examplesFile)]
    ])
  } finally {
    await oracle.client.close()
  }
}

async function main(): Promise<void> {
  const files = await build()
  if (!process.argv.includes('--check')) {
    mkdirSync(OUT_DIR, { recursive: true })
    for (const [name, text] of files) writeFileSync(path.join(OUT_DIR, name), text, 'utf8')
    process.stdout.write(`wrote ${[...files.keys()].join(', ')} to ${OUT_DIR}\n`)
    return
  }
  const stale = [...files].filter(([name, text]) => {
    try {
      return readFileSync(path.join(OUT_DIR, name), 'utf8') !== text
    } catch {
      return true
    }
  })
  if (stale.length > 0) {
    process.stderr.write(
      `vectors:agent-mcp:check failed: ${stale.map(([name]) => name).join(', ')} missing or regenerate differently.\n` +
        'Run `pnpm --filter @memry/desktop vectors:agent-mcp` and commit the result.\n'
    )
    process.exit(1)
  }
  process.stdout.write('vectors:agent-mcp:check passed\n')
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exit(1)
})
