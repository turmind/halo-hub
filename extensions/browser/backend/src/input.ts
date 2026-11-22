import type { CDPSession } from 'playwright'
import { BROWSER_LIMITS, BROWSER_VIEWPORT, type BrowserInputEvent } from './protocol.js'
import { BrowserFault } from './errors.js'

const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const integer = (value: unknown, min: number, max: number) => number(value, min, max) && Number.isInteger(value)
export function validateInput(value: unknown): BrowserInputEvent {
  const v = value as Record<string, unknown> | null
  let valid = false
  if (v && typeof v === 'object') {
    if (v.kind === 'release-all') valid = true
    if (v.kind === 'text') valid = typeof v.text === 'string' && v.text.length <= BROWSER_LIMITS.inputTextChars
    if (v.kind === 'key') valid = ['down', 'up'].includes(String(v.event)) && typeof v.key === 'string' && v.key.length > 0 && v.key.length <= 64 && typeof v.code === 'string' && /^[A-Za-z0-9]{0,40}$/.test(v.code) && integer(v.keyCode, 0, 255) && integer(v.modifiers, 0, 15)
    if (v.kind === 'pointer' || v.kind === 'wheel') {
      valid = number(v.x, 0, BROWSER_VIEWPORT.width - 1) && number(v.y, 0, BROWSER_VIEWPORT.height - 1) && integer(v.modifiers, 0, 15)
      valid &&= v.kind === 'pointer'
        ? ['move', 'down', 'up'].includes(String(v.event)) && ['none', 'left', 'middle', 'right'].includes(String(v.button)) && integer(v.buttons, 0, 7) && integer(v.clickCount, 0, 3)
        : number(v.deltaX, -10000, 10000) && number(v.deltaY, -10000, 10000)
    }
  }
  if (!valid) throw new BrowserFault('invalid-request')
  return value as BrowserInputEvent
}
export class InputDispatcher {
  private keys = new Map<string, Extract<BrowserInputEvent, { kind: 'key' }>>()
  private buttons = new Set<'left' | 'middle' | 'right'>()
  private point = { x: 0, y: 0 }
  constructor(private cdp: CDPSession) {}
  async send(event: BrowserInputEvent): Promise<void> {
    if (event.kind === 'release-all') {
      for (const key of this.keys.values()) await this.send({ ...key, event: 'up', modifiers: 0 })
      for (const button of this.buttons) await this.send({ kind: 'pointer', event: 'up', ...this.point, button, buttons: 0, clickCount: 1, modifiers: 0 })
    } else if (event.kind === 'text') await this.cdp.send('Input.insertText', { text: event.text })
    else if (event.kind === 'key') {
      if (event.event === 'down') this.keys.set(event.code || event.key, event)
      else this.keys.delete(event.code || event.key)
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: event.event === 'down' ? 'keyDown' : 'keyUp', key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: event.modifiers,
        ...(event.event === 'down' && event.key.length === 1 && !(event.modifiers & 6) ? { text: event.key } : {}),
      })
    } else {
      this.point = { x: event.x, y: event.y }
      if (event.kind === 'wheel') await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...this.point, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers })
      else {
        if (event.button !== 'none') { if (event.event === 'down') this.buttons.add(event.button); if (event.event === 'up') this.buttons.delete(event.button) }
        await this.cdp.send('Input.dispatchMouseEvent', { type: event.event === 'move' ? 'mouseMoved' : event.event === 'down' ? 'mousePressed' : 'mouseReleased', ...this.point, button: event.button, buttons: event.buttons, clickCount: event.clickCount, modifiers: event.modifiers })
      }
    }
  }
}
