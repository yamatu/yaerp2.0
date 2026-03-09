'use client'

import { Check, FunctionSquare, PencilLine } from 'lucide-react'

interface Props {
  activeCellLabel: string
  value: string
  readOnly: boolean
  onChange: (value: string) => void
  onApply: () => void
}

export default function FormulaBar({
  activeCellLabel,
  value,
  readOnly,
  onChange,
  onApply,
}: Props) {
  return (
    <div className="border-b border-slate-200/80 bg-white/90 px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="flex items-center gap-2">
          <div className="inline-flex min-w-24 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 shadow-inner">
            {activeCellLabel || '未选择'}
          </div>
          <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500 shadow-sm">
            <FunctionSquare className="h-4 w-4 text-sky-600" />
            公式栏
          </div>
        </div>

        <div className="flex flex-1 items-center gap-3">
          <label className="relative flex-1">
            <PencilLine className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !readOnly) {
                  e.preventDefault()
                  onApply()
                }
              }}
              className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50/80 pl-10 pr-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-70"
              placeholder={activeCellLabel ? '输入文本、数值或公式' : '先选择一个单元格'}
              disabled={!activeCellLabel}
              readOnly={readOnly}
            />
          </label>

          <button
            type="button"
            onClick={onApply}
            disabled={!activeCellLabel || readOnly}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-slate-900 px-4 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            应用
          </button>
        </div>
      </div>
    </div>
  )
}
