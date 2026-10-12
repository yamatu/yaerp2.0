'use client'

/**
 * Transient toasts and promise-based confirmation dialogs for admin pages.
 * `AdminProviders` is mounted by app/admin/layout.tsx, i.e. above the page
 * components, so every admin page can call `useToast()` / `useConfirm()`
 * directly. AdminShell also mounts it when rendered outside that layout.
 */

import { AlertTriangle, CheckCircle2, Info, ShieldAlert, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, TextInput } from './ui'

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

type ToastTone = 'success' | 'error' | 'info' | 'warning'

interface ToastItem {
  id: number
  tone: ToastTone
  message: ReactNode
}

interface ToastApi {
  success: (message: ReactNode) => void
  error: (message: ReactNode) => void
  info: (message: ReactNode) => void
  warning: (message: ReactNode) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const toastStyles: Record<ToastTone, { box: string; icon: typeof Info }> = {
  success: { box: 'border-emerald-200 bg-white text-slate-800', icon: CheckCircle2 },
  error: { box: 'border-rose-200 bg-white text-slate-800', icon: XCircle },
  info: { box: 'border-sky-200 bg-white text-slate-800', icon: Info },
  warning: { box: 'border-amber-200 bg-white text-slate-800', icon: AlertTriangle },
}

const toastIconColor: Record<ToastTone, string> = {
  success: 'text-emerald-600',
  error: 'text-rose-600',
  info: 'text-sky-600',
  warning: 'text-amber-600',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const sequence = useRef(0)

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])

  const push = useCallback(
    (tone: ToastTone, message: ReactNode) => {
      const id = ++sequence.current
      setItems((current) => [...current.slice(-2), { id, tone, message }])
      window.setTimeout(() => dismiss(id), tone === 'error' ? 6500 : 3500)
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
      warning: (message) => push('warning', message),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Shown at the top so toasts never cover dialog footers, the sticky save bar or the mobile tab bar. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[95] flex flex-col items-center gap-2 md:inset-x-auto md:right-5 md:top-[76px] md:items-end"
      >
        {items.map((item) => {
          const style = toastStyles[item.tone]
          const Icon = style.icon
          return (
            <div key={item.id} role={item.tone === 'error' ? 'alert' : 'status'} className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg ${style.box}`}>
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${toastIconColor[item.tone]}`} />
              <div className="min-w-0 flex-1 leading-6">{item.message}</div>
              <button type="button" onClick={() => dismiss(item.id)} aria-label="关闭" className="-m-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) {
    // Fallback keeps pages usable outside the shell (should not happen in practice).
    return { success: () => undefined, error: (message) => console.error(message), info: () => undefined, warning: () => undefined }
  }
  return context
}

/* ------------------------------------------------------------------ */
/* Confirm                                                             */
/* ------------------------------------------------------------------ */

export interface ConfirmOptions {
  title: ReactNode
  message?: ReactNode
  /** Bullet list of consequences shown in the dialog. */
  consequences?: ReactNode[]
  confirmText?: string
  cancelText?: string
  tone?: 'danger' | 'primary'
  /** When set, the user must type this text before confirming. */
  requireText?: string
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null)
  const [typed, setTyped] = useState('')

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setTyped('')
        setState({ ...options, resolve })
      }),
    [],
  )

  const close = (value: boolean) => {
    state?.resolve(value)
    setState(null)
  }

  const danger = (state?.tone || 'danger') === 'danger'
  const blocked = Boolean(state?.requireText) && typed.trim() !== state?.requireText

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(false)}
        title={state?.title}
        icon={danger ? ShieldAlert : Info}
        iconTone={danger ? 'rose' : 'sky'}
        size="sm"
        footer={
          <>
            <Button onClick={() => close(false)}>{state?.cancelText || '取消'}</Button>
            <Button variant={danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)} data-autofocus={state?.requireText ? undefined : true}>
              {state?.confirmText || '确认'}
            </Button>
          </>
        }
      >
        {state && (
          <div className="space-y-3 text-sm leading-6 text-slate-600">
            {state.message && <div>{state.message}</div>}
            {state.consequences && state.consequences.length > 0 && (
              <ul className={`space-y-1.5 rounded-lg border px-3 py-2.5 text-[13px] ${danger ? 'border-rose-100 bg-rose-50/60 text-rose-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                {state.consequences.map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <span className={`mt-2 h-1 w-1 shrink-0 rounded-full ${danger ? 'bg-rose-400' : 'bg-slate-400'}`} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
            {state.requireText && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600">
                  请输入 <span className="rounded bg-slate-100 px-1 font-mono text-slate-900">{state.requireText}</span> 以确认
                </span>
                <TextInput value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-autofocus />
              </label>
            )}
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext)
  if (!context) return async (options) => window.confirm(typeof options.title === 'string' ? options.title : '确认操作？')
  return context
}

/** Mounts the toast + confirm providers once; nested usages are no-ops. */
export function AdminProviders({ children }: { children: ReactNode }) {
  const alreadyProvided = useContext(ToastContext) !== null
  if (alreadyProvided) return <>{children}</>
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  )
}
