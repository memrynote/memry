import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRegistration } from '../server'
import type { WriteToolGate } from '../tools/write-tools'

const mocks = vi.hoisted(() => {
  const readTool = { name: 'vault_read_note' } as ToolRegistration
  const writeTool = { name: 'vault_create_note' } as ToolRegistration
  const handles = { kind: 'handles' }
  const serverHandle = {
    url: 'http://127.0.0.1:1234',
    ['token']: 'local-token-placeholder',
    ['rotateToken']: vi.fn(() => 'rotated-local-token-placeholder'),
    registerTool: vi.fn(),
    stop: vi.fn(async () => {})
  }

  return {
    readTool,
    writeTool,
    handles,
    serverHandle,
    getDatabase: vi.fn(() => 'data-db'),
    getIndexDatabase: vi.fn(() => 'index-db'),
    createVaultServiceHandles: vi.fn(() => handles),
    buildReadTools: vi.fn(() => [readTool]),
    buildWriteTools: vi.fn(() => [writeTool]),
    startAgentMcpServer: vi.fn(async () => serverHandle)
  }
})

vi.mock('../../../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: mocks.getIndexDatabase
}))

vi.mock('../tools/handles-adapter', () => ({
  createVaultServiceHandles: mocks.createVaultServiceHandles
}))

vi.mock('../tools/read-tools', () => ({
  buildReadTools: mocks.buildReadTools
}))

vi.mock('../tools/write-tools', () => ({
  buildWriteTools: mocks.buildWriteTools
}))

vi.mock('../server', () => ({
  startAgentMcpServer: mocks.startAgentMcpServer
}))

import {
  getPublicStatus,
  rotateToken,
  setWriteGate,
  startAgentMcpLifecycle,
  stopAgentMcpLifecycle
} from '../lifecycle'

describe('Agent MCP lifecycle', () => {
  beforeEach(() => {
    mocks.getDatabase.mockClear()
    mocks.getIndexDatabase.mockClear()
    mocks.createVaultServiceHandles.mockClear()
    mocks.buildReadTools.mockClear()
    mocks.buildWriteTools.mockClear()
    mocks.startAgentMcpServer.mockClear()
    mocks.serverHandle.rotateToken.mockClear()
    mocks.serverHandle.registerTool.mockClear()
    mocks.serverHandle.stop.mockClear()
  })

  afterEach(async () => {
    await stopAgentMcpLifecycle()
    setWriteGate(null)
  })

  it('starts the server with read and write tool registrations', async () => {
    await startAgentMcpLifecycle()

    expect(mocks.createVaultServiceHandles).toHaveBeenCalledWith({
      dataDb: 'data-db',
      indexDb: 'index-db'
    })
    expect(mocks.buildReadTools).toHaveBeenCalledWith(mocks.handles)
    expect(mocks.buildWriteTools).toHaveBeenCalledWith(mocks.handles, null)
    expect(mocks.startAgentMcpServer).toHaveBeenCalledWith({
      toolRegistrations: [mocks.readTool, mocks.writeTool]
    })
    expect(getPublicStatus()).toEqual({
      url: 'http://127.0.0.1:1234',
      ['token']: 'local-token-placeholder',
      toolCount: 2
    })
  })

  it('does not start or stop twice', async () => {
    await startAgentMcpLifecycle()
    await startAgentMcpLifecycle()

    expect(mocks.startAgentMcpServer).toHaveBeenCalledTimes(1)

    await stopAgentMcpLifecycle()
    await stopAgentMcpLifecycle()

    expect(mocks.serverHandle.stop).toHaveBeenCalledTimes(1)
    expect(getPublicStatus()).toEqual({ url: null, ['token']: null, toolCount: 0 })
  })

  // The listening server's tool closures capture the vault databases at start
  // time, so stopping has to drop the handle and not just close the socket:
  // whatever a later start hands to the tools is what an MCP client reaches.
  it('rebinds to the current vault databases after a stop', async () => {
    await startAgentMcpLifecycle()

    expect(mocks.createVaultServiceHandles).toHaveBeenLastCalledWith({
      dataDb: 'data-db',
      indexDb: 'index-db'
    })

    await stopAgentMcpLifecycle()
    mocks.getDatabase.mockReturnValueOnce('next-vault-data-db')
    mocks.getIndexDatabase.mockReturnValueOnce('next-vault-index-db')

    await startAgentMcpLifecycle()

    expect(mocks.startAgentMcpServer).toHaveBeenCalledTimes(2)
    expect(mocks.createVaultServiceHandles).toHaveBeenLastCalledWith({
      dataDb: 'next-vault-data-db',
      indexDb: 'next-vault-index-db'
    })
  })

  it('rotates the running server token', async () => {
    expect(() => rotateToken()).toThrow('Agent MCP server not running')

    await startAgentMcpLifecycle()

    expect(rotateToken()).toBe('rotated-local-token-placeholder')
    expect(mocks.serverHandle.rotateToken).toHaveBeenCalledTimes(1)
  })

  it('re-registers write tools when the write gate changes', async () => {
    await startAgentMcpLifecycle()

    const gate: WriteToolGate = vi.fn()
    setWriteGate(gate)

    expect(mocks.buildWriteTools).toHaveBeenLastCalledWith(mocks.handles, gate)
    expect(mocks.serverHandle.registerTool).toHaveBeenCalledWith(mocks.writeTool)
  })
})
