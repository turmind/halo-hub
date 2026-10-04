import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, MainMenu, getCommonBounds, hashElementsVersion, languages, restore, serializeAsJSON } from '@excalidraw/excalidraw'

// Halo Canvas extension protocol v1 — see the Halo docs (design/canvas-extensions.md).
const post = (m, transfer) => parent.postMessage({ haloExt: 1, ...m }, '*', transfer)

// UI language follows the browser (the protocol carries no locale); locales are bundled, nothing is fetched.
const pickLang = () => {
  const nav = (navigator.language || 'en').toLowerCase()
  const codes = languages.map((l) => l.code)
  return codes.find((c) => c.toLowerCase() === nav) ?? codes.find((c) => c.toLowerCase().split('-')[0] === nav.split('-')[0]) ?? 'en'
}
const langCode = pickLang()

// onChange also fires for selection / scroll / tool switches, so "dirty" compares a signature of what the
// file actually stores: element versions, canvas background + grid, and the set of embedded images.
// Deleted elements are skipped: drawing something and undoing it should land back on the clean state.
const signature = (elements, appState, files) =>
  `${hashElementsVersion(elements.filter((el) => !el.isDeleted))}|${appState.viewBackgroundColor}|${appState.gridModeEnabled}|${Object.keys(files).sort().join(',')}`

const parseBoard = (buffer) => {
  const text = new TextDecoder().decode(buffer)
  if (!text.trim()) return { elements: [], appState: {}, files: {} }
  const data = JSON.parse(text)
  if (!data || typeof data !== 'object' || !Array.isArray(data.elements)) throw new Error('Not an Excalidraw scene (no "elements" array)')
  // Same options as Excalidraw's own file loader. (refreshDimensions would re-measure text before the
  // board's fonts are loaded and clip it, so it stays off.)
  return restore(data, null, null, { refreshDimensions: false, repairBindings: true })
}

function App() {
  const [doc, setDoc] = useState(null) // { id, initialData } — a new id remounts Excalidraw (fresh undo history)
  const [theme, setTheme] = useState('light')
  const apiRef = useRef(null)
  const docIdRef = useRef(0)
  // baseline: signature of what is on disk; current: latest seen; reported: dirty state the host knows about.
  const sync = useRef({ baseline: null, current: null, reported: false, awaitingBaseline: false })

  const reportDirty = () => {
    const s = sync.current
    const dirty = s.baseline !== null && s.current !== s.baseline
    if (dirty === s.reported) return
    s.reported = dirty
    post({ type: 'dirty', dirty })
  }

  const onChange = (id, elements, appState, files) => {
    if (id !== docIdRef.current) return // late event from a replaced instance
    const s = sync.current
    s.current = signature(elements, appState, files)
    // The first change after a load is the scene as Excalidraw normalised it (e.g. missing fractional
    // indices added) — that is the baseline, not a user edit. Also when the view is framed (the file does
    // not store scroll / zoom): a board that fits is centred at 100 %, a larger one is zoomed out to fit.
    if (s.awaitingBaseline) {
      s.awaitingBaseline = false
      s.baseline = s.current
      const visible = elements.filter((el) => !el.isDeleted)
      if (visible.length) {
        const [x1, y1, x2, y2] = getCommonBounds(visible)
        const fits = x2 - x1 <= appState.width * 0.8 && y2 - y1 <= appState.height * 0.7
        apiRef.current?.scrollToContent(visible, fits ? undefined : { fitToViewport: true, viewportZoomFactor: 0.7 })
      }
    }
    reportDirty()
  }

  const save = async () => {
    const api = apiRef.current
    if (!api) return
    // A text box still open commits on blur; give it a tick to land in the scene.
    if (api.getAppState().editingTextElement) {
      document.activeElement?.blur()
      await new Promise((r) => setTimeout(r, 50))
    }
    const elements = api.getSceneElements() // without deleted tombstones: the file stays clean
    const appState = api.getAppState()
    const files = api.getFiles()
    sync.current.sent = signature(elements, appState, files)
    const buffer = new TextEncoder().encode(serializeAsJSON(elements, appState, files, 'local')).buffer
    post({ type: 'save', buffer }, [buffer])
  }

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== parent || e.data?.haloExt !== 1) return
      const m = e.data
      if (m.type === 'init' || m.type === 'theme') setTheme(m.theme === 'dark' ? 'dark' : 'light')
      else if (m.type === 'load') {
        let board
        try { board = parseBoard(m.buffer) } catch (err) { post({ type: 'error', message: `Cannot open as an Excalidraw board: ${err.message}` }); return }
        const s = sync.current
        s.baseline = s.current = null
        s.reported = false // the host clears its dirty flag on every load
        s.awaitingBaseline = true
        docIdRef.current += 1
        setDoc({ id: docIdRef.current, initialData: board })
      } else if (m.type === 'save-request') void save()
      else if (m.type === 'saved') {
        // The host now considers the document clean; edits made while the save was in flight make it dirty again.
        const s = sync.current
        s.baseline = s.sent
        s.reported = false
        reportDirty()
      }
    }
    // Ctrl/Cmd+S inside the frame never reaches the admin, and the browser would "save page" — save unprompted.
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      e.stopPropagation()
      if (sync.current.reported || apiRef.current?.getAppState().editingTextElement) void save()
    }
    // No allow-popups / allow-top-navigation in the sandbox: a followed link would navigate the iframe away.
    const onLinkClick = (e) => { if (e.target instanceof Element && e.target.closest('a[href]')) e.preventDefault() }
    addEventListener('message', onMessage)
    addEventListener('keydown', onKeyDown, true)
    addEventListener('click', onLinkClick, true)
    addEventListener('auxclick', onLinkClick, true)
    post({ type: 'ready', protocol: 1 })
    return () => {
      removeEventListener('message', onMessage)
      removeEventListener('keydown', onKeyDown, true)
      removeEventListener('click', onLinkClick, true)
      removeEventListener('auxclick', onLinkClick, true)
    }
  }, [])

  if (!doc) return null
  return (
    <Excalidraw
      key={doc.id}
      initialData={doc.initialData}
      excalidrawAPI={(api) => { apiRef.current = api }}
      onChange={(elements, appState, files) => onChange(doc.id, elements, appState, files)}
      theme={theme}
      langCode={langCode}
      autoFocus
      handleKeyboardGlobally
      aiEnabled={false}
      validateEmbeddable={false}
      // Links can't open from the sandbox (and a same-origin one would navigate this iframe): show the URL instead.
      onLinkOpen={(element, event) => {
        event.preventDefault()
        apiRef.current?.setToast({ message: element.link, closable: true, duration: 6000 })
      }}
      // Loading another scene / saving to a file handle / exporting images all need file pickers or downloads,
      // which the iframe sandbox does not grant; the board is saved through the host instead.
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false } }}
    >
      {/* The default menu's Socials block is external links; theme follows the admin, so no theme toggle either. */}
      <MainMenu>
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.CommandPalette />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  )
}

createRoot(document.getElementById('root')).render(<App />)
