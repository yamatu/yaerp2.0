'use client'

import {
  AlertCircle,
  Columns3,
  Lock,
  LoaderCircle,
  Plus,
  Rows3,
  ShieldCheck,
  Trash2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'

const quickColors = ['#0f172a', '#2563eb', '#059669', '#dc2626', '#d97706', '#7c3aed']

interface Props {
  saveStatus: 'saved' | 'saving' | 'error'
  activeCellLabel: string
  zoomLevel: number
  canEditSheet: boolean
  canManageStructure: boolean
  canDeleteRow: boolean
  canDeleteColumn: boolean
  isActiveCellLocked: boolean
  activeTextColor: string
  onZoomChange: (value: number) => void
  onAddRow: () => void
  onDeleteRow: () => void
  onOpenAddColumn: () => void
  onDeleteColumn: () => void
  onToggleLock: () => void
  onTextColorChange: (value: string) => void
}

export default function Toolbar({
  saveStatus,
  activeCellLabel,
  zoomLevel,
  canEditSheet,
  canManageStructure,
  canDeleteRow,
  canDeleteColumn,
  isActiveCellLocked,
  activeTextColor,
  onZoomChange,
  onAddRow,
  onDeleteRow,
  onOpenAddColumn,
  onDeleteColumn,
  onToggleLock,
  onTextColorChange,
}: Props) {
  const statusConfig = {
    saved: {
      icon: ShieldCheck,
      text: '已自动保存',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    },
    saving: {
      icon: LoaderCircle,
      text: '正在同步',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
    },
    error: {
      icon: AlertCircle,
      text: '保存失败',
      className: 'border-rose-200 bg-rose-50 text-rose-700',
    },
  }

  const status = statusConfig[saveStatus]
  const StatusIcon = status.icon

  return (
    <div className="border-b border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.98))] px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
            当前单元格 {activeCellLabel || '未选择'}
          </div>

          <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={onAddRow}
              disabled={!canEditSheet}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Rows3 className="h-3.5 w-3.5" />
              添加行
            </button>
            <button
              type="button"
              onClick={onDeleteRow}
              disabled={!canEditSheet || !canDeleteRow}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除行
            </button>
          </div>

          {canManageStructure && (
            <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1 shadow-sm">
              <button
                type="button"
                onClick={onOpenAddColumn}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
              >
                <Columns3 className="h-3.5 w-3.5" />
                添加列
              </button>
              <button
                type="button"
                onClick={onDeleteColumn}
                disabled={!canDeleteColumn}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除列
              </button>
              <button
                type="button"
                onClick={onToggleLock}
                disabled={!activeCellLabel}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isActiveCellLocked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {isActiveCellLocked ? '解除锁定' : '锁定单元格'}
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 shadow-sm">
            <span className="text-xs font-semibold text-slate-500">文字颜色</span>
            <div className="flex items-center gap-1">
              {quickColors.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => onTextColorChange(color)}
                  className={`h-6 w-6 rounded-full border border-white shadow-sm ring-2 transition ${
                    activeTextColor === color ? 'ring-slate-400' : 'ring-transparent'
                  }`}
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>
            <input
              type="color"
              value={activeTextColor}
              onChange={(event) => onTextColorChange(event.target.value)}
              className="h-7 w-7 cursor-pointer rounded-full border border-slate-200 bg-transparent p-0"
              title="自定义文字颜色"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 shadow-sm">
            <button
              type="button"
              onClick={() => onZoomChange(Math.max(70, zoomLevel - 10))}
              className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title="缩小表格"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <input
              type="range"
              min={70}
              max={160}
              step={10}
              value={zoomLevel}
              onChange={(event) => onZoomChange(Number(event.target.value))}
              className="w-24 accent-slate-900"
              title="缩放表格"
            />
            <button
              type="button"
              onClick={() => onZoomChange(Math.min(160, zoomLevel + 10))}
              className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title="放大表格"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <span className="min-w-12 text-right text-xs font-semibold text-slate-600">{zoomLevel}%</span>
          </div>

          <div
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold shadow-sm ${status.className}`}
          >
            <StatusIcon className={`h-3.5 w-3.5 ${saveStatus === 'saving' ? 'animate-spin' : ''}`} />
            {status.text}
          </div>
        </div>
      </div>
    </div>
  )
}
