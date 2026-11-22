import type { BrowserViewport } from '../backend/src/protocol.js'

export function fitViewport(width: number, height: number, viewport: BrowserViewport) {
  const scale = Math.min(width / viewport.width, height / viewport.height)
  return { scale, width: viewport.width * scale, height: viewport.height * scale,
    left: (width - viewport.width * scale) / 2, top: (height - viewport.height * scale) / 2 }
}

/** DOM coordinates are CSS pixels already; multiplying by devicePixelRatio would double-scale input. */
export function remotePoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewport: BrowserViewport, captured = false) {
  if (!rect.width || !rect.height) return null
  const x = (clientX - rect.left) * viewport.width / rect.width
  const y = (clientY - rect.top) * viewport.height / rect.height
  if (!captured && (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)) return null
  return { x: Math.max(0, Math.min(viewport.width - 1, x)), y: Math.max(0, Math.min(viewport.height - 1, y)) }
}
