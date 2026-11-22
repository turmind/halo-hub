import { BROWSER_LIMITS, type BrowserInputEvent, type BrowserViewport } from '../backend/src/protocol.js'
import { remotePoint } from './geometry.js'

const modifiers = (event: MouseEvent | KeyboardEvent) => Number(event.altKey) | Number(event.ctrlKey) * 2 | Number(event.metaKey) * 4 | Number(event.shiftKey) * 8

export function bindInput(canvas: HTMLCanvasElement, input: HTMLTextAreaElement, viewport: () => BrowserViewport,
  enabled: () => boolean, send: (event: BrowserInputEvent) => void, warn: (message: 'textLimit' | 'clipboard') => void) {
  let composing = false
  let committedComposition: string | null = null
  let heldPointer: number | undefined
  const release = () => {
    if (enabled()) send({ kind: 'release-all' })
    const pointer = heldPointer; heldPointer = undefined
    if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer)
    composing = false; committedComposition = null; input.value = ''
  }
  const text = (value: string) => {
    if (!enabled() || !value) return
    if (value.length > BROWSER_LIMITS.inputTextChars) { warn('textLimit'); return }
    send({ kind: 'text', text: value })
  }
  let lastClick = { time: 0, x: 0, y: 0, button: -1, count: 0 }
  canvas.addEventListener('pointerdown', event => {
    if (!enabled() || !event.isPrimary || event.button > 2) return
    event.preventDefault(); input.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId)
    heldPointer = event.pointerId
    const repeated = event.timeStamp - lastClick.time < 500 && event.button === lastClick.button
      && Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) < 5
    lastClick = { time: event.timeStamp, x: event.clientX, y: event.clientY, button: event.button, count: repeated ? lastClick.count % 3 + 1 : 1 }
  })
  for (const [dom, event] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up']] as const) {
    canvas.addEventListener(dom, e => {
      if (!enabled() || !e.isPrimary || e.button > 2) return
      const point = remotePoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), viewport(), canvas.hasPointerCapture(e.pointerId))
      if (!point) return
      e.preventDefault()
      send({ kind: 'pointer', event, ...point, button: e.button === 0 ? 'left' : e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'none',
        buttons: e.buttons & 7, clickCount: event === 'move' ? 0 : lastClick.count, modifiers: modifiers(e) })
      if (event === 'up') { heldPointer = undefined; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) }
    })
  }
  canvas.addEventListener('pointercancel', release)
  canvas.addEventListener('lostpointercapture', () => { if (heldPointer !== undefined) release() })
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('wheel', e => {
    if (!enabled()) return
    const point = remotePoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), viewport())
    if (!point) return
    e.preventDefault()
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport().height : 1
    const clamp = (n: number) => Math.max(-10000, Math.min(10000, n * unit))
    send({ kind: 'wheel', ...point, deltaX: clamp(e.deltaX), deltaY: clamp(e.deltaY), modifiers: modifiers(e) })
  }, { passive: false })
  for (const [dom, event] of [['keydown', 'down'], ['keyup', 'up']] as const) {
    input.addEventListener(dom, e => {
      if (!enabled() || composing || e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return
      // Paste belongs to the local textarea, then insertText; remote clipboard is not synchronized.
      if ((e.ctrlKey || e.metaKey) && ['v', 'c', 'x'].includes(e.key.toLowerCase())) {
        if (e.key.toLowerCase() !== 'v') { e.preventDefault(); warn('clipboard') }
        return
      }
      e.preventDefault()
      send({ kind: 'key', event, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e) })
    })
  }
  input.addEventListener('compositionstart', () => { composing = true; committedComposition = null })
  input.addEventListener('compositionend', e => { composing = false; committedComposition = e.data; text(e.data); input.value = '' })
  input.addEventListener('input', e => {
    if (composing || (e as InputEvent).isComposing) return
    const value = input.value || (e as InputEvent).data || ''
    // Engines differ on whether a final input follows compositionend. Consume that commit once.
    if (committedComposition === null || value !== committedComposition) text(value)
    committedComposition = null; input.value = ''
  })
  input.addEventListener('paste', e => { e.preventDefault(); committedComposition = null; text(e.clipboardData?.getData('text/plain') ?? '') })
  input.addEventListener('blur', release)
  window.addEventListener('blur', release)
  return release
}
