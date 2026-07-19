'use client'

import { ArchiveRestore, ArrowLeft, BriefcaseBusiness, Clock3, FileSpreadsheet, Folder, RefreshCw, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import type { DeletedTradeOrder, Folder as FolderResource, RecycleBinContents, Workbook } from '@/types'

const TRADE_STAGE_LABELS: Record<string, string> = {
  inquiry: '客户询价',
  supplier_quote: '供应商询价',
  quotation: '对客报价与议价',
  purchase: '采购执行',
  receiving: '仓库到货',
  inspection: '质量检验',
  packing: '装箱',
  shipment: '发货',
  completed: '业务完成',
  cancelled: '已取消',
}

function formatDate(value?: string) {
  if (!value) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function remainingDays(deletedAt: string | undefined, retentionDays: number) {
  if (!deletedAt) return retentionDays
  const expiresAt = new Date(deletedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
}

export default function RecycleBinPage() {
  const [contents, setContents] = useState<RecycleBinContents>({ folders: [], workbooks: [], trade_orders: [], retention_days: 30 })
  const [loading, setLoading] = useState(true)
  const [actionKey, setActionKey] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const loadContents = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get<RecycleBinContents>('/recycle-bin')
      if (response.code !== 0 || !response.data) throw new Error(response.message || '加载回收站失败')
      setContents(response.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载回收站失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadContents()
  }, [loadContents])

  const total = contents.folders.length + contents.workbooks.length + contents.trade_orders.length
  const retentionDays = contents.retention_days || 30
  const oldestRemaining = useMemo(() => {
    const days = [
      ...contents.folders.map((folder) => remainingDays(folder.deleted_at, retentionDays)),
      ...contents.workbooks.map((workbook) => remainingDays(workbook.deleted_at, retentionDays)),
      ...contents.trade_orders.map((order) => remainingDays(order.deleted_at, retentionDays)),
    ]
    return days.length > 0 ? Math.min(...days) : retentionDays
  }, [contents.folders, contents.trade_orders, contents.workbooks, retentionDays])

  const runAction = async (kind: 'folders' | 'workbooks' | 'trade-orders', id: number, action: 'restore' | 'delete', name: string) => {
    if (action === 'delete') {
      const detail = kind === 'trade-orders'
        ? '订单内的产品、报价、流程记录和关联工作簿都会永久删除，且无法还原。'
        : '此操作无法还原。'
      if (!window.confirm(`确定要永久删除「${name}」吗？${detail}`)) return
    }
    const key = `${kind}-${id}-${action}`
    setActionKey(key)
    setError('')
    setMessage('')
    try {
      const endpoint = `/recycle-bin/${kind}/${id}${action === 'restore' ? '/restore' : ''}`
      const response = action === 'restore' ? await api.post(endpoint) : await api.delete(endpoint)
      if (response.code !== 0) throw new Error(response.message || '操作失败')
      setMessage(action === 'restore' ? `已还原「${name}」` : `已永久删除「${name}」`)
      await loadContents()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setActionKey('')
    }
  }

  const renderWorkbook = (workbook: Workbook) => (
    <div key={workbook.id} className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700"><FileSpreadsheet className="h-5 w-5" /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{workbook.name}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>所有者：{workbook.owner_name || `用户 #${workbook.owner_id}`}</span>
            <span>删除人：{workbook.deleted_by_name || `用户 #${workbook.deleted_by_id || '-'}`}</span>
            <span>{formatDate(workbook.deleted_at)}</span>
          </div>
        </div>
      </div>
      <ResourceActions days={remainingDays(workbook.deleted_at, retentionDays)} busy={actionKey.startsWith(`workbooks-${workbook.id}-`)} onRestore={() => void runAction('workbooks', workbook.id, 'restore', workbook.name)} onDelete={() => void runAction('workbooks', workbook.id, 'delete', workbook.name)} />
    </div>
  )

  const renderFolder = (folder: FolderResource) => (
    <div key={folder.id} className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><Folder className="h-5 w-5" /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{folder.name}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>包含删除时的子目录和工作簿</span>
            <span>删除人：{folder.deleted_by_name || `用户 #${folder.deleted_by_id || '-'}`}</span>
            <span>{formatDate(folder.deleted_at)}</span>
          </div>
        </div>
      </div>
      <ResourceActions days={remainingDays(folder.deleted_at, retentionDays)} busy={actionKey.startsWith(`folders-${folder.id}-`)} onRestore={() => void runAction('folders', folder.id, 'restore', folder.name)} onDelete={() => void runAction('folders', folder.id, 'delete', folder.name)} />
    </div>
  )

  const renderTradeOrder = (order: DeletedTradeOrder) => {
    const customer = order.customer_company || order.customer_name || '未命名客户'
    const name = `${order.order_no} ${order.title}`.trim()
    return (
      <div key={order.id} className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 last:border-b-0 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700"><BriefcaseBusiness className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-slate-950">{order.order_no}</span>
              <span className="truncate text-sm text-slate-700">{order.title}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>客户：{customer}</span>
              <span>阶段：{TRADE_STAGE_LABELS[order.stage] || order.stage}</span>
              <span>负责人：{order.owner_name || `用户 #${order.owner_id}`}</span>
              <span>删除人：{order.deleted_by_name || `用户 #${order.deleted_by_id || '-'}`}</span>
              <span>{formatDate(order.deleted_at)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-slate-600">
              <span>产品 {order.item_count}</span>
              <span>供应商报价 {order.supplier_quote_count}</span>
              <span>对客报价 {order.customer_quote_count}</span>
              <span>流程记录 {order.stage_event_count}</span>
              {order.inspection_photo_count > 0 && <span>质检照片 {order.inspection_photo_count}</span>}
              {order.workbook_name && <span>工作簿：{order.workbook_name}</span>}
            </div>
          </div>
        </div>
        <ResourceActions days={remainingDays(order.deleted_at, retentionDays)} busy={actionKey.startsWith(`trade-orders-${order.id}-`)} onRestore={() => void runAction('trade-orders', order.id, 'restore', name)} onDelete={() => void runAction('trade-orders', order.id, 'delete', name)} />
      </div>
    )
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100 p-3 md:p-5">
        <div className="mx-auto max-w-[1200px] space-y-3">
          <header className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Link href="/" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" title="返回工作台"><ArrowLeft className="h-4 w-4" /></Link>
              <div className="min-w-0">
                <h1 className="text-xl font-semibold text-slate-950">回收站</h1>
                <p className="mt-0.5 text-sm text-slate-500">删除内容保留 {retentionDays} 天，过期后自动清理</p>
              </div>
            </div>
            <button type="button" onClick={() => void loadContents()} disabled={loading} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
          </header>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4"><div className="text-xs text-slate-500">待处理内容</div><div className="mt-1 text-2xl font-semibold text-slate-950">{total}</div></div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4"><div className="text-xs text-slate-500">业务订单</div><div className="mt-1 text-2xl font-semibold text-slate-950">{contents.trade_orders.length}</div></div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4"><div className="text-xs text-slate-500">工作簿与目录</div><div className="mt-1 text-2xl font-semibold text-slate-950">{contents.workbooks.length + contents.folders.length}</div></div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4"><div className="text-xs text-slate-500">最近到期</div><div className="mt-1 text-2xl font-semibold text-slate-950">{total > 0 ? `${oldestRemaining} 天` : '-'}</div></div>
          </section>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
          {message && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

          {loading ? (
            <div className="flex h-56 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在加载回收站</div>
          ) : total === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-slate-200 bg-white text-center shadow-sm"><Trash2 className="h-8 w-8 text-slate-300" /><div className="mt-3 text-sm font-semibold text-slate-700">回收站为空</div><div className="mt-1 text-xs text-slate-400">删除的业务订单、工作簿和文件夹会出现在这里</div></div>
          ) : (
            <div className="space-y-3">
              {contents.trade_orders.length > 0 && <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3"><div><div className="text-sm font-semibold text-slate-800">已删除业务订单</div><div className="mt-0.5 text-xs text-slate-500">还原时会一并恢复产品、报价、流程记录和关联工作簿</div></div><span className="text-xs text-slate-500">{contents.trade_orders.length} 个</span></div>{contents.trade_orders.map(renderTradeOrder)}</section>}
              {contents.folders.length > 0 && <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3"><span className="text-sm font-semibold text-slate-800">已删除文件夹</span><span className="text-xs text-slate-500">{contents.folders.length} 个</span></div>{contents.folders.map(renderFolder)}</section>}
              {contents.workbooks.length > 0 && <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3"><span className="text-sm font-semibold text-slate-800">已删除工作簿</span><span className="text-xs text-slate-500">{contents.workbooks.length} 个</span></div>{contents.workbooks.map(renderWorkbook)}</section>}
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  )
}

function ResourceActions({ days, busy, onRestore, onDelete }: { days: number; busy: boolean; onRestore: () => void; onDelete: () => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
      <span className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium ${days <= 3 ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'}`}><Clock3 className="h-3.5 w-3.5" />剩余 {days} 天</span>
      <button type="button" onClick={onRestore} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-sky-200 px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"><ArchiveRestore className="h-3.5 w-3.5" />还原</button>
      <button type="button" onClick={onDelete} disabled={busy} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50" title="永久删除" aria-label="永久删除" data-tooltip="永久删除"><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
  )
}
