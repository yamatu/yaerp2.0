'use client'

import Link from 'next/link'
import { BookOpen, ChevronDown, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'

export interface HelpSection {
  title: string
  items: ReactNode[]
  tone?: 'default' | 'warning'
}

export interface HelpContent {
  /** One or two sentences: what this module is for. */
  intro: ReactNode
  sections: HelpSection[]
  related?: Array<{ label: string; href: string }>
}

interface HelpPanelProps {
  content: HelpContent
  open: boolean
  onToggle: () => void
}

/** Collapsible "使用说明" panel shown at the top of every admin page. */
export function HelpPanel({ content, open, onToggle }: HelpPanelProps) {
  return (
    <section id="admin-help" className="overflow-hidden rounded-lg border border-sky-200 bg-sky-50/50">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-12 w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-sky-50"
      >
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-sky-700 shadow-sm">
          <BookOpen className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">使用说明</span>
          <span className="mt-0.5 block text-xs leading-5 text-slate-600">{content.intro}</span>
        </span>
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-sky-700">
          <span className="hidden sm:inline">{open ? '收起' : '展开详细说明'}</span>
          <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="border-t border-sky-100 bg-white/70 px-4 py-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {content.sections.map((section) => (
              <div key={section.title} className={section.tone === 'warning' ? 'rounded-lg border border-amber-200 bg-amber-50/60 p-3' : ''}>
                <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wide ${section.tone === 'warning' ? 'text-amber-800' : 'text-slate-500'}`}>{section.title}</h3>
                <ul className="space-y-1.5">
                  {section.items.map((item, index) => (
                    <li key={index} className="flex gap-2 text-[13px] leading-6 text-slate-700">
                      <span className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${section.tone === 'warning' ? 'bg-amber-500' : 'bg-sky-400'}`} />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {content.related && content.related.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <span>相关模块：</span>
              {content.related.map((link) => (
                <Link key={link.href} href={link.href} className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 font-medium text-slate-700 hover:bg-slate-50">
                  {link.label}
                  <ExternalLink className="h-3 w-3 text-slate-400" />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Inline emphasis helper for help copy. */
export function Em({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-slate-900">{children}</strong>
}
