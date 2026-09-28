import { useEffect } from 'react'
import { useSigma } from '@react-sigma/core'
import type Graph from 'graphology'
import { PINNED_ATTRIBUTE } from '@/lib/graph-physics'

const LAYER_ID = 'pinMarkers'
/** Gap between a node's edge and its pin ring, in screen px. */
const RING_GAP_PX = 2.5
const RING_WIDTH_PX = 1.25

/**
 * Draws a thin ring around every pinned node on a 2D layer above the WebGL
 * nodes, redrawn after each sigma render so it follows pan, zoom and motion.
 * Pins are few, so walking the graph per frame costs no more than a physics tick.
 */
export function GraphPinMarkers({ graph, color }: { graph: Graph; color: string }): null {
  const sigma = useSigma()

  useEffect(() => {
    // Same guard as SigmaSettingsSync: skip a killed instance React may still hand us.
    if (sigma.getGraph() !== graph) return

    sigma.createCanvasContext(LAYER_ID, { style: { pointerEvents: 'none' } })
    const canvas = sigma.getCanvases()[LAYER_ID]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const draw = (): void => {
      const { width, height } = sigma.getDimensions()
      const ratio = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio)
      if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.strokeStyle = color
      ctx.lineWidth = RING_WIDTH_PX

      graph.forEachNode((id, attrs) => {
        if (attrs[PINNED_ATTRIBUTE] !== true) return
        const display = sigma.getNodeDisplayData(id)
        if (!display || display.hidden) return
        const { x, y } = sigma.framedGraphToViewport(display)
        const radius = sigma.scaleSize(display.size) + RING_GAP_PX
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, 2 * Math.PI)
        ctx.stroke()
      })
    }

    sigma.on('afterRender', draw)
    draw()

    return () => {
      sigma.off('afterRender', draw)
      if (sigma.getCanvases()[LAYER_ID]) sigma.killLayer(LAYER_ID)
    }
  }, [sigma, graph, color])

  return null
}
