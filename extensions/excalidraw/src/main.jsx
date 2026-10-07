import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CaptureUpdateAction, Excalidraw, MainMenu, exportToBlob, exportToSvg, getCommonBounds, hashElementsVersion, languages, restore, serializeAsJSON } from '@excalidraw/excalidraw'

// Halo Canvas extension protocol v1 — see the Halo docs (design/canvas-extensions.md).
const post = (m, transfer) => parent.postMessage({ haloExt: 1, ...m }, '*', transfer)

// UI language follows the browser (the protocol carries no locale); locales are bundled, nothing is fetched.
const pickLang = () => {
  const nav = (navigator.language || 'en').toLowerCase()
  const codes = languages.map((l) => l.code)
  return codes.find((c) => c.toLowerCase() === nav) ?? codes.find((c) => c.toLowerCase().split('-')[0] === nav.split('-')[0]) ?? 'en'
}
const langCode = pickLang()
const zh = langCode.startsWith('zh')
const L = zh
  ? { png: '导出 PNG', svg: '导出 SVG', empty: '画布为空，没有可导出的内容', exported: (p) => `已导出到 ${p}`, failed: (m) => `导出失败：${m}` }
  : { png: 'Export PNG', svg: 'Export SVG', empty: 'Nothing to export: the board is empty', exported: (p) => `Exported to ${p}`, failed: (m) => `Export failed: ${m}` }

// onChange also fires for selection / scroll / tool switches, so "dirty" compares a signature of what the
// file actually stores: element versions, canvas background + grid, and the set of embedded images.
// Deleted elements are skipped: drawing something and undoing it should land back on the clean state.
const signature = (elements, appState, files) =>
  `${hashElementsVersion(elements.filter((el) => !el.isDeleted))}|${appState.viewBackgroundColor}|${appState.gridModeEnabled}|${Object.keys(files).sort().join(',')}`

const parseBoard = (buffer) => {
  const text = new TextDecoder().decode(buffer)
  // An empty file is a blank board; restore() fills in the default canvas settings either way.
  const data = text.trim() ? JSON.parse(text) : { elements: [] }
  if (!data || typeof data !== 'object' || !Array.isArray(data.elements)) throw new Error('Not an Excalidraw scene (no "elements" array)')
  // Same options as Excalidraw's own file loader. (refreshDimensions would re-measure text before the
  // board's fonts are loaded and clip it, so it stays off.)
  return restore(data, null, null, { refreshDimensions: false, repairBindings: true })
}

function App() {
  const [doc, setDoc] = useState(null) // { initialData } — set by the first load only; later loads update the scene in place
  const [theme, setTheme] = useState('light')
  // init.export: the host writes `export` frames next to the file (older hosts omit it → no export items).
  const [canExport, setCanExport] = useState(false)
  const stemRef = useRef('board') // open file name without its extension — exports are <stem>.png / .svg
  const apiRef = useRef(null)
  // baseline: signature of what is on disk; current: latest seen; reported: dirty state the host knows about.
  const sync = useRef({ baseline: null, current: null, reported: false, awaitingBaseline: false })

  const reportDirty = () => {
    const s = sync.current
    const dirty = s.baseline !== null && s.current !== s.baseline
    if (dirty === s.reported) return
    s.reported = dirty
    post({ type: 'dirty', dirty })
  }

  const onChange = (elements, appState, files) => {
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

  // Excalidraw's own image export needs downloads (not granted to the sandbox); render here, let the host write the file.
  const exportImage = async (kind) => {
    const api = apiRef.current
    if (!api) return
    const elements = api.getSceneElements()
    if (!elements.length) { api.setToast({ message: L.empty, closable: true, duration: 4000 }); return }
    const opts = { elements, appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false }, files: api.getFiles(), exportPadding: 10 }
    let buffer
    try {
      if (kind === 'png') {
        const blob = await exportToBlob({ ...opts, mimeType: 'image/png', getDimensions: (width, height) => ({ width: width * 2, height: height * 2, scale: 2 }) })
        buffer = await blob.arrayBuffer()
      } else {
        const svg = await exportToSvg(opts)
        buffer = new TextEncoder().encode(new XMLSerializer().serializeToString(svg)).buffer
      }
    } catch (err) {
      api.setToast({ message: L.failed(err.message), closable: true, duration: 4000 })
      return
    }
    post({ type: 'export', name: `${stemRef.current}.${kind}`, buffer }, [buffer])
  }

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== parent || e.data?.haloExt !== 1) return
      const m = e.data
      if (m.type === 'init' || m.type === 'theme') setTheme(m.theme === 'dark' ? 'dark' : 'light')
      if (m.type === 'init') {
        setCanExport(m.export === true)
        stemRef.current = String(m.file?.name ?? '').replace(/\.[^.]*$/, '') || 'board'
      } else if (m.type === 'exported') apiRef.current?.setToast({ message: L.exported(m.path), closable: true, duration: 4000 })
      else if (m.type === 'export-error') {
        if (m.reason !== 'cancelled') apiRef.current?.setToast({ message: L.failed(m.message), closable: true, duration: 4000 })
      } else if (m.type === 'load') {
        let board
        try { board = parseBoard(m.buffer) } catch (err) { post({ type: 'error', message: `Cannot open as an Excalidraw board: ${err.message}` }); return }
        const s = sync.current
        s.reported = false // the host clears its dirty flag on every load
        const api = apiRef.current
        if (!api) {
          // First load: mount with it; the first onChange sets the baseline and frames the view.
          s.baseline = s.current = null
          s.awaitingBaseline = true
          setDoc({ initialData: board })
          return
        }
        // Later loads (file changed on disk, "discard and reload"): update the scene in place. Remounting
        // flashed the whole editor and reset zoom / scroll. Only what the file stores is applied — the
        // view is kept — and the change stays out of the undo history.
        const { viewBackgroundColor, gridModeEnabled, gridSize, gridStep } = board.appState
        api.addFiles(Object.values(board.files))
        api.updateScene({ elements: board.elements, appState: { viewBackgroundColor, gridModeEnabled, gridSize, gridStep }, captureUpdate: CaptureUpdateAction.NEVER })
        // Undo steps recorded against the old file would replay onto the new one; a remount used to drop them.
        api.history.clear()
        // New baseline right away, or the next onChange reads the external change as an edit. Elements /
        // files are read back (updateScene normalises indices synchronously); the canvas settings come
        // from the board, since React may not have applied updateScene's setState yet.
        s.baseline = s.current = signature(api.getSceneElements(), { viewBackgroundColor, gridModeEnabled }, api.getFiles())
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
      initialData={doc.initialData}
      excalidrawAPI={(api) => { apiRef.current = api }}
      onChange={onChange}
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
        {canExport && <MainMenu.Separator />}
        {canExport && <MainMenu.Item onSelect={() => void exportImage('png')}>{L.png}</MainMenu.Item>}
        {canExport && <MainMenu.Item onSelect={() => void exportImage('svg')}>{L.svg}</MainMenu.Item>}
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  )
}

createRoot(document.getElementById('root')).render(<App />)
