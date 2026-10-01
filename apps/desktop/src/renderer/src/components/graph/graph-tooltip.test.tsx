import { render } from '@testing-library/react'
import Graph from 'graphology'
import { describe, expect, it, vi } from 'vitest'

import { GraphTooltip } from './graph-tooltip'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

describe('GraphTooltip', () => {
  // A project node carries the project's stored icon, and a new project gets the
  // legacy lucide name "Folder" (`createDefaultProject`).
  it("draws a project node's legacy icon name as a glyph, not as literal text", () => {
    const graph = new Graph()
    graph.addNode('project-1', {
      label: 'Roadmap',
      nodeType: 'project',
      tags: [],
      connectionCount: 1,
      emoji: 'Folder',
      isUnresolved: false
    })

    const { container } = render(<GraphTooltip nodeId="project-1" graph={graph} x={0} y={0} />)

    expect(container.textContent).not.toContain('Folder')
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})
