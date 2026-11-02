import { IRenderManagerService } from '@univerjs/engine-render'
import { ISheetSelectionRenderService } from '@univerjs/sheets-ui'

/**
 * Recovers two keyboard states of the sheet that a lost browser event leaves
 * stuck.
 *
 * 1. Lost compositionend. Univer's cell editor ignores every keydown and input
 *    while an input method composition is open, and only a compositionend on
 *    its hidden input ends that state. macOS input methods (Pinyin, Japanese,
 *    accent press-and-hold) sometimes never send it when the user clicks away
 *    mid-word, so all later edits - Backspace, typing, Enter - did nothing
 *    until the page was reloaded. A keydown the browser reports as not
 *    composing proves the composition is over: the missing compositionend is
 *    sent then, before the editor handles that key, with the last composed
 *    text so nothing typed is lost.
 *
 * 2. Lost pointerup. Univer switches keyboard shortcuts (copy, paste, undo)
 *    off while a selection is dragged and back on at pointerup. A pointerup
 *    that never comes (pointercancel, a system gesture, switching apps
 *    mid-click) left them off. The lock is released as soon as the pointer is
 *    seen with no button pressed, or the window loses focus.
 */

const RETRY_INTERVAL_MS = 100
const MAX_ATTEMPTS = 100

interface DisposableLike {
  dispose?: () => void
}

interface SelectionServiceLike {
  _escapeShortcutDisposable?: DisposableLike | null
  _onPointerDown?: (...args: unknown[]) => unknown
  endSelection?: () => void
}

function isComposingKey(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229 || event.key === 'Process'
}

export function registerUniverInputRecovery(
  univer: unknown,
  unitId: string,
  root: HTMLElement,
  onRecovered?: (what: 'composition' | 'shortcuts') => void
): { dispose: () => void } {
  const disposers: Array<() => void> = []
  let disposed = false

  // ---- 1. compositions ---------------------------------------------------
  const pendingCompositions = new Map<EventTarget, string>()
  let finishing = false
  const inSheet = (target: EventTarget | null) =>
    target instanceof Node && (root.contains(target) || (target instanceof Element && Boolean(target.closest('[data-u-comp="editor"]'))))

  const onCompositionStart = (event: CompositionEvent) => {
    if (!finishing && event.target && inSheet(event.target)) pendingCompositions.set(event.target, event.data || '')
  }
  const onCompositionUpdate = (event: CompositionEvent) => {
    if (event.target && pendingCompositions.has(event.target)) pendingCompositions.set(event.target, event.data || '')
  }
  const onCompositionEnd = (event: CompositionEvent) => {
    if (event.target) pendingCompositions.delete(event.target)
  }
  const finishStaleCompositions = (event: KeyboardEvent | InputEvent) => {
    if (pendingCompositions.size === 0) return
    if (event instanceof KeyboardEvent ? isComposingKey(event) : event.isComposing || event.inputType.includes('Composition')) return
    const stale = [...pendingCompositions]
    pendingCompositions.clear()
    finishing = true
    try {
      for (const [target, data] of stale) {
        target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }))
      }
    } finally {
      finishing = false
    }
    onRecovered?.('composition')
  }
  const onKeyDown = (event: KeyboardEvent) => finishStaleCompositions(event)
  const onBeforeInput = (event: Event) => {
    if (event instanceof InputEvent) finishStaleCompositions(event)
  }
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionupdate', onCompositionUpdate, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('beforeinput', onBeforeInput, true)
  disposers.push(() => {
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionupdate', onCompositionUpdate, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('beforeinput', onBeforeInput, true)
  })

  // ---- 2. shortcut lock of a selection drag ------------------------------
  let selectionService: SelectionServiceLike | null = null
  const releaseShortcutLock = () => {
    const service = selectionService
    if (!service?._escapeShortcutDisposable) return
    service.endSelection?.()
    if (service._escapeShortcutDisposable) {
      service._escapeShortcutDisposable.dispose?.()
      service._escapeShortcutDisposable = null
    }
    onRecovered?.('shortcuts')
  }
  const onPointerWithoutButtons = (event: PointerEvent) => {
    if (event.buttons === 0) releaseShortcutLock()
  }
  const onPointerCancel = () => releaseShortcutLock()
  const onWindowBlur = () => releaseShortcutLock()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') releaseShortcutLock()
  }
  window.addEventListener('pointermove', onPointerWithoutButtons, { capture: true, passive: true })
  window.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibility)
  disposers.push(() => {
    window.removeEventListener('pointermove', onPointerWithoutButtons, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('blur', onWindowBlur)
    document.removeEventListener('visibilitychange', onVisibility)
  })

  // A new press while a lost one still holds the lock would otherwise stack a
  // second lock on top of it.
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  const install = (): boolean => {
    const injector = (univer as { __getInjector?: () => { get: <T>(token: unknown) => T } } | null)?.__getInjector?.()
    const renderManager = injector?.get<IRenderManagerService | undefined>(IRenderManagerService)
    const service = renderManager?.getRenderUnitById(unitId)?.with(ISheetSelectionRenderService) as unknown as SelectionServiceLike | undefined
    const original = service?._onPointerDown
    if (!service || typeof original !== 'function') return false
    const patched = function patchedOnPointerDown(this: SelectionServiceLike, ...args: unknown[]) {
      if (this._escapeShortcutDisposable) {
        this._escapeShortcutDisposable.dispose?.()
        this._escapeShortcutDisposable = null
      }
      return original.apply(this, args)
    }
    service._onPointerDown = patched
    selectionService = service
    disposers.push(() => {
      if (service._onPointerDown === patched) service._onPointerDown = original
      selectionService = null
    })
    return true
  }
  const attempt = () => {
    timer = null
    if (disposed) return
    let installed = false
    try {
      installed = install()
    } catch {
      installed = false
    }
    if (installed) return
    attempts += 1
    if (attempts < MAX_ATTEMPTS) timer = setTimeout(attempt, RETRY_INTERVAL_MS)
  }
  attempt()

  return {
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      disposers.splice(0).forEach((dispose) => dispose())
    },
  }
}
