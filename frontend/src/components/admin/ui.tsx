'use client'

/**
 * Admin UI kit. Every admin page is built from these primitives so buttons,
 * controls, tables and dialogs share one look: slate palette, rounded-lg,
 * white cards and h-9 controls (h-10 on phones for 40px touch targets).
 */

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Search,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'accent' | 'ghost' | 'success'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
  'danger-outline': 'border border-rose-200 bg-white text-rose-600 hover:bg-rose-50',
  accent: 'border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700',
}

const buttonBase =
  'inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-lg text-sm font-medium transition [-webkit-tap-highlight-color:transparent] disabled:cursor-not-allowed disabled:opacity-50'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: LucideIcon
  loading?: boolean
  size?: 'md' | 'sm'
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon: Icon, loading, size = 'md', block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        buttonBase,
        buttonVariants[variant],
        size === 'md' ? 'h-10 px-3.5 md:h-9 md:px-3' : 'h-10 px-3 text-xs md:h-8 md:px-2.5',
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  variant?: ButtonVariant
  loading?: boolean
  spin?: boolean
}

export function IconButton({ icon: Icon, label, variant = 'secondary', loading, spin, className, disabled, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      data-tooltip={label}
      disabled={disabled || loading}
      className={cx(buttonBase, buttonVariants[variant], 'ui-tooltip h-10 w-10 md:h-9 md:w-9', className)}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className={cx('h-4 w-4', spin && 'animate-spin')} />}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

export const controlClass =
  'block h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 md:h-9'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(controlClass, className)} {...rest} />
})

export function SelectInput({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(controlClass, 'pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

export interface SearchSelectOption {
  id: number
  label: string
  /** Secondary text, also searched. */
  description?: string
  /** Options sharing a group are listed under one heading. */
  group?: string
}

interface SearchSelectProps {
  value: number | null
  onChange: (id: number) => void
  options: SearchSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

const SEARCH_SELECT_LIMIT = 200

/** Select with a search box, for lists too long for a native select. */
export function SearchSelect({ value, onChange, options, placeholder = '请选择', searchPlaceholder = '搜索', emptyText = '没有匹配的选项', disabled, className, 'aria-label': ariaLabel }: SearchSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selected = options.find((option) => option.id === value) || null

  const { filtered, hiddenCount } = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN')
    const matches = keyword
      ? options.filter((option) => `${option.label} ${option.description || ''} ${option.group || ''}`.toLocaleLowerCase('zh-CN').includes(keyword))
      : options
    return { filtered: matches.slice(0, SEARCH_SELECT_LIMIT), hiddenCount: Math.max(0, matches.length - SEARCH_SELECT_LIMIT) }
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const index = options.findIndex((option) => option.id === value)
    setActiveIndex(index >= 0 && index < SEARCH_SELECT_LIMIT ? index : 0)
  }, [open, options, value])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const choose = (option: SearchSelectOption | undefined) => {
    if (!option) return
    onChange(option.id)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cx('relative min-w-0', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={cx(controlClass, 'flex items-center gap-2 pr-2 text-left')}
      >
        <span className={cx('min-w-0 flex-1 truncate', !selected && 'text-slate-400')}>
          {selected ? (selected.group ? `${selected.group} / ${selected.label}` : selected.label) : placeholder}
        </span>
        <ChevronDown className={cx('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              type="text"
              inputMode="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)) }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)) }
                else if (event.key === 'Enter') { event.preventDefault(); choose(filtered[activeIndex]) }
                else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
              }}
              placeholder={searchPlaceholder}
              aria-controls={listId}
              className={cx(controlClass, 'h-9!')}
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-400">{emptyText}</div>
            ) : (
              filtered.map((option, index) => {
                const showGroup = option.group && option.group !== filtered[index - 1]?.group
                return (
                  <div key={option.id}>
                    {showGroup && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold text-slate-400">{option.group}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.id === value}
                      data-index={index}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(option)}
                      className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-sm', index === activeIndex ? 'bg-sky-50 text-sky-900' : 'text-slate-700')}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.label}</span>
                        {option.description && <span className="block truncate text-xs text-slate-400">{option.description}</span>}
                      </span>
                      {option.id === value && <Check className="h-4 w-4 shrink-0 text-sky-600" />}
                    </button>
                  </div>
                )
              })
            )}
            {hiddenCount > 0 && <div className="px-3 py-2 text-center text-[11px] text-slate-400">还有 {hiddenCount} 项，请输入关键词缩小范围</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        'block w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:bg-slate-50',
        className,
      )}
      {...rest}
    />
  )
}

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
  children: ReactNode
  /** Extra element rendered on the right side of the label row. */
  aside?: ReactNode
  /** Render as a div (for groups of chips / several controls). */
  group?: boolean
}

/** Labelled form field with an optional explanatory hint below the control. */
export function Field({ label, hint, error, required, className, children, aside, group }: FieldProps) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className={cx('block min-w-0', className)}>
      <span className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
        {aside}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-rose-600">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs leading-5 text-slate-500">{hint}</span>
      ) : null}
    </Tag>
  )
}

interface SwitchFieldProps {
  label: ReactNode
  hint?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  tone?: 'default' | 'warning'
  className?: string
}

/** Full-row toggle; the whole row is the touch target. */
export function SwitchField({ label, hint, checked, onChange, disabled, tone = 'default', className }: SwitchFieldProps) {
  const id = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={id}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'flex min-h-12 w-full items-center justify-between gap-4 rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60',
        tone === 'warning' ? 'border-amber-200 bg-amber-50/60 hover:bg-amber-50' : 'border-slate-200 bg-white hover:bg-slate-50',
        className,
      )}
    >
      <span id={id} className="min-w-0">
        <span className={cx('block text-sm font-medium', tone === 'warning' ? 'text-amber-900' : 'text-slate-800')}>{label}</span>
        {hint && <span className={cx('mt-0.5 block text-xs leading-5', tone === 'warning' ? 'text-amber-700' : 'text-slate-500')}>{hint}</span>}
      </span>
      <span className={cx('relative inline-flex h-6 w-11 shrink-0 rounded-full transition', checked ? (tone === 'warning' ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-slate-300')}>
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  )
}

interface CheckboxRowProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
  className?: string
}

export function CheckboxRow({ checked, onChange, label, hint, disabled, className }: CheckboxRowProps) {
  return (
    <label
      className={cx(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition',
        checked ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:bg-slate-50',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-slate-900"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-5 text-slate-500">{hint}</span>}
      </span>
    </label>
  )
}

/** Toggleable chip, e.g. for picking roles. */
export function Chip({ active, onClick, children, disabled }: { active: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cx(
        'inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9',
        active ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {active && <CheckCircle2 className="h-3.5 w-3.5" />}
      {children}
    </button>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: ReactNode; count?: number }>
  className?: string
}

export function Segmented<T extends string>({ value, onChange, options, className }: SegmentedProps<T>) {
  return (
    <div className={cx('flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 [scrollbar-width:none]', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition md:h-8',
            value === option.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {option.label}
          {option.count !== undefined && <span className={cx('text-xs tabular-nums', value === option.value ? 'text-slate-500' : 'text-slate-400')}>{option.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Status & notices                                                    */
/* ------------------------------------------------------------------ */

export type Tone = 'slate' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet'

const badgeTones: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-600',
  emerald: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  rose: 'bg-rose-50 text-rose-700',
  sky: 'bg-sky-50 text-sky-700',
  violet: 'bg-violet-50 text-violet-700',
}

const dotTones: Record<Tone, string> = {
  slate: 'bg-slate-400',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
}

export function StatusBadge({ tone = 'slate', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium', badgeTones[tone], className)}>
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', dotTones[tone])} />}
      {children}
    </span>
  )
}

type NoticeTone = 'info' | 'success' | 'warning' | 'danger'

const noticeStyles: Record<NoticeTone, { box: string; icon: LucideIcon }> = {
  info: { box: 'border-sky-200 bg-sky-50 text-sky-800', icon: Info },
  success: { box: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: CheckCircle2 },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-800', icon: AlertTriangle },
  danger: { box: 'border-rose-200 bg-rose-50 text-rose-700', icon: XCircle },
}

interface NoticeProps {
  tone?: NoticeTone
  title?: ReactNode
  children?: ReactNode
  onClose?: () => void
  action?: ReactNode
  className?: string
}

/** Inline, persistent message (as opposed to the transient toast). */
export function Notice({ tone = 'info', title, children, onClose, action, className }: NoticeProps) {
  const style = noticeStyles[tone]
  const Icon = style.icon
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', style.box, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 leading-6">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={title ? 'text-[13px] opacity-90' : ''}>{children}</div>}
      </div>
      {action}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="关闭提示" className="-m-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

interface SectionCardProps {
  title?: ReactNode
  description?: ReactNode
  icon?: LucideIcon
  iconTone?: Tone
  actions?: ReactNode
  children?: ReactNode
  /** Remove body padding (for tables / lists that run edge to edge). */
  flush?: boolean
  tone?: 'default' | 'danger'
  className?: string
  bodyClassName?: string
  id?: string
}

const iconTiles: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-600',
  emerald: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  rose: 'bg-rose-50 text-rose-700',
  sky: 'bg-sky-50 text-sky-700',
  violet: 'bg-violet-50 text-violet-700',
}

export function SectionCard({ title, description, icon: Icon, iconTone = 'slate', actions, children, flush, tone = 'default', className, bodyClassName, id }: SectionCardProps) {
  return (
    <section id={id} className={cx('min-w-0 overflow-hidden rounded-lg border bg-white', tone === 'danger' ? 'border-rose-200' : 'border-slate-200', className)}>
      {(title || actions) && (
        <div className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3', children !== undefined && 'border-b border-slate-200')}>
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
            {Icon && (
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', iconTiles[tone === 'danger' ? 'rose' : iconTone])}>
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
              {description && <p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={cx(!flush && 'p-4', bodyClassName)}>{children}</div>}
    </section>
  )
}

interface ToolbarProps {
  search?: string
  onSearch?: (value: string) => void
  placeholder?: string
  children?: ReactNode
  actions?: ReactNode
  className?: string
}

/** Search + filters + actions row, typically the first child of a flush SectionCard. */
export function Toolbar({ search, onSearch, placeholder = '搜索', children, actions, className }: ToolbarProps) {
  return (
    <div className={cx('flex flex-col gap-2 border-b border-slate-200 p-3 md:flex-row md:flex-wrap md:items-center', className)}>
      {/* On phones the search and the actions share the first row; filters wrap below. */}
      <div className="flex items-center gap-2 md:contents">
        {onSearch && <SearchInput value={search || ''} onChange={onSearch} placeholder={placeholder} className="min-w-0 flex-1 md:order-1 md:w-72 md:flex-none" />}
        {actions && <div className="flex shrink-0 items-center gap-2 md:order-3 md:ml-auto">{actions}</div>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2 md:order-2">{children}</div>}
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (value: string) => void; placeholder?: string; className?: string }) {
  return (
    <label className={cx('relative block min-w-0', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        type="text"
        inputMode="search"
        enterKeyHint="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cx(controlClass, 'pl-9 pr-9')}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="清空搜索" className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:text-slate-700">
          <X className="h-4 w-4" />
        </button>
      )}
    </label>
  )
}

export interface StatItem {
  label: string
  value: ReactNode
  icon?: LucideIcon
  tone?: Tone
  hint?: ReactNode
}

const statIconTones: Record<Tone, string> = {
  slate: 'text-slate-500',
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  rose: 'text-rose-600',
  sky: 'text-sky-600',
  violet: 'text-violet-600',
}

export function StatGrid({ items, className }: { items: StatItem[]; className?: string }) {
  const columns = items.length >= 4 ? 'md:grid-cols-4' : items.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'
  return (
    <section className={cx('grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200', columns, className)}>
      {items.map((item) => {
        const Icon = item.icon
        return (
          <div key={item.label} className="flex min-h-[72px] items-center gap-3 bg-white px-4 py-3">
            {Icon && <Icon className={cx('h-5 w-5 shrink-0', statIconTones[item.tone || 'slate'])} />}
            <div className="min-w-0">
              <div className="truncate text-xl font-semibold tabular-nums text-slate-900">{item.value}</div>
              <div className="truncate text-xs text-slate-500">{item.label}</div>
              {item.hint && <div className="truncate text-[11px] text-slate-400">{item.hint}</div>}
            </div>
          </div>
        )
      })}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Empty / loading                                                     */
/* ------------------------------------------------------------------ */

export function EmptyState({ icon: Icon, title, description, action, compact }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 text-center', compact ? 'py-8' : 'py-14')}>
      {Icon && (
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {description && <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function LoadingState({ label = '正在加载…', compact }: { label?: string; compact?: boolean }) {
  return (
    <div className={cx('flex items-center justify-center gap-2 text-sm text-slate-400', compact ? 'py-8' : 'py-14')}>
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Data table (table on desktop, stacked cards on phones)              */
/* ------------------------------------------------------------------ */

export interface DataColumn<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  className?: string
  align?: 'left' | 'right'
  /**
   * How the column appears in the mobile card:
   * - title: bold first line, badge: top right, actions: footer row,
   * - hidden: omitted, field (default): "label: value" row.
   */
  mobile?: 'title' | 'badge' | 'actions' | 'hidden' | 'field'
}

interface DataTableProps<T> {
  rows: T[]
  columns: Array<DataColumn<T>>
  rowKey: (row: T) => string | number
  loading?: boolean
  empty?: ReactNode
  onRowClick?: (row: T) => void
  selectedKey?: string | number | null
  loadingLabel?: string
}

export function DataTable<T>({ rows, columns, rowKey, loading, empty, onRowClick, selectedKey, loadingLabel }: DataTableProps<T>) {
  if (loading && rows.length === 0) return <LoadingState label={loadingLabel} />
  if (rows.length === 0) return <>{empty ?? <EmptyState title="暂无数据" />}</>

  const titleColumns = columns.filter((column) => column.mobile === 'title')
  const badgeColumns = columns.filter((column) => column.mobile === 'badge')
  const actionColumns = columns.filter((column) => column.mobile === 'actions')
  const fieldColumns = columns.filter((column) => !column.mobile || column.mobile === 'field')

  return (
    <div className={cx(loading && 'opacity-60 transition-opacity')}>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={cx('whitespace-nowrap px-4 py-2.5 font-medium', column.align === 'right' ? 'text-right' : 'text-left', column.className)}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => {
              const key = rowKey(row)
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cx(onRowClick && 'cursor-pointer', selectedKey === key ? 'bg-sky-50/70' : 'hover:bg-slate-50/70')}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={cx('px-4 py-3 align-middle text-slate-700', column.align === 'right' && 'text-right', column.className)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-slate-100 md:hidden">
        {rows.map((row) => {
          const key = rowKey(row)
          return (
            <li
              key={key}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cx('px-4 py-3', onRowClick && 'cursor-pointer active:bg-slate-50', selectedKey === key && 'bg-sky-50/70')}
            >
              {(titleColumns.length > 0 || badgeColumns.length > 0) && (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">{titleColumns.map((column) => <div key={column.key}>{column.render(row)}</div>)}</div>
                  {badgeColumns.length > 0 && <div className="flex shrink-0 flex-col items-end gap-1">{badgeColumns.map((column) => <div key={column.key}>{column.render(row)}</div>)}</div>}
                </div>
              )}
              {fieldColumns.length > 0 && (
                <dl className="mt-2 space-y-1.5">
                  {fieldColumns.map((column) => (
                    <div key={column.key} className="flex items-start gap-3 text-sm">
                      <dt className="w-16 shrink-0 pt-0.5 text-xs text-slate-400">{column.header}</dt>
                      <dd className="min-w-0 flex-1 text-slate-700">{column.render(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {actionColumns.length > 0 && (
                <div className="mt-3 flex flex-wrap justify-end gap-2" onClick={(event) => event.stopPropagation()}>
                  {actionColumns.map((column) => <div key={column.key} className="contents">{column.render(row)}</div>)}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function Pagination({ page, totalPages, total, onChange, disabled }: { page: number; totalPages: number; total?: number; onChange: (page: number) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-500">
      <span>
        第 {page} / {totalPages} 页{total !== undefined && ` · 共 ${total.toLocaleString('zh-CN')} 条`}
      </span>
      <div className="flex gap-2">
        <Button size="sm" icon={ChevronLeft} onClick={() => onChange(Math.max(1, page - 1))} disabled={disabled || page <= 1}>
          上一页
        </Button>
        <Button size="sm" onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={disabled || page >= totalPages}>
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Modal: centered dialog on desktop, bottom sheet on phones            */
/* ------------------------------------------------------------------ */

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  icon?: LucideIcon
  iconTone?: Tone
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Drawer slides in from the right on desktop; still a bottom sheet on phones. */
  variant?: 'dialog' | 'drawer'
  /** Prevent closing (e.g. while a request is running). */
  busy?: boolean
}

const modalSizes = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }

export function Modal({ open, onClose, title, description, icon: Icon, iconTone = 'slate', children, footer, size = 'md', variant = 'dialog', busy }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    const focusTimer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([disabled]), select, textarea')
      if (target && window.matchMedia('(pointer: fine)').matches) target.focus()
    }, 30)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(focusTimer)
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const drawer = variant === 'drawer'
  return createPortal(
    <div
      className={cx('fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45', drawer ? 'sm:items-stretch sm:justify-end' : 'sm:items-center sm:p-4')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={cx(
          'flex max-h-[calc(var(--vv-height,100dvh)-1.5rem)] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-2xl',
          drawer ? 'sm:h-full sm:max-h-none sm:max-w-xl sm:rounded-none' : cx('sm:max-h-[88vh] sm:rounded-lg', modalSizes[size]),
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-300 sm:hidden" aria-hidden />
        <header className="flex shrink-0 items-start gap-3 border-b border-slate-200 px-4 py-3">
          {Icon && (
            <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', iconTiles[iconTone])}>
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            {description && <p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            className="-mr-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 md:h-9 md:w-9"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-3 [&>*]:w-full sm:[&>*]:w-auto">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Small key/value list used in detail panels. */
export function DetailList({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {items.map((item, index) => (
        <div key={index} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-xs text-slate-500 sm:w-28 sm:pt-0.5">{item.label}</dt>
          <dd className="min-w-0 break-words text-sm text-slate-800">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Form action bar. While `pinned` (typically: there are unsaved changes) it
 * sticks to the bottom of the phone viewport, just above the mobile tab bar.
 */
export function StickyActions({ children, note, pinned = true }: { children: ReactNode; note?: ReactNode; pinned?: boolean }) {
  return (
    <div
      className={cx(
        'rounded-lg border border-slate-200 bg-white px-4 py-3',
        pinned && 'max-md:sticky max-md:bottom-[var(--mobile-tabbar-offset)] max-md:z-20 max-md:-mx-3 max-md:rounded-none max-md:border-x-0 max-md:border-b-0 max-md:bg-white/95 max-md:px-3 max-md:py-2.5 max-md:shadow-[0_-4px_12px_-6px_rgba(15,23,42,0.18)] max-md:backdrop-blur',
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {note ? <div className="text-xs leading-5 text-slate-500">{note}</div> : <span className="hidden sm:block" />}
        <div className="flex flex-wrap gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">{children}</div>
      </div>
    </div>
  )
}
