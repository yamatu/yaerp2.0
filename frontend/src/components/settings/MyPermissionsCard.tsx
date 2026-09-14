'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, Loader2, Lock, Shield, ShieldCheck } from 'lucide-react'
import api from '@/lib/api'

interface SheetPermissionEntry {
  sheet_id: number
  sheet_name: string
  can_view?: boolean
  can_edit?: boolean
  can_delete?: boolean
  can_export?: boolean
  writable_columns?: string[]
  readonly_columns?: string[]
  hidden_columns?: string[]
}

interface WorkbookPermissionEntry {
  workbook_id: number
  workbook_name: string
  owner_name?: string | null
  access_level?: string
  sheet_count?: number
  is_locked?: boolean
  is_hidden?: boolean
  sheets?: SheetPermissionEntry[]
}

export interface PermissionSnapshot {
  user_id: number
  is_admin: boolean
  role_codes: string[]
  role_names: string[]
  features: Record<string, boolean>
  workbook_note?: string
  workbooks: WorkbookPermissionEntry[]
  workbook_total: number
  sheet_total: number
  note?: string
}

/**
 * Labels for every capability the backend reports. The list is explicit so an
 * unknown flag is never presented to an employee with a misleading name.
 */
const FEATURE_LABELS: Array<{ key: string; label: string; description: string }> = [
  { key: 'use_ai_assistant', label: 'AI 智能助手', description: '对话式查询、统计与批量修改' },
  { key: 'create_workbook', label: '新建工作簿', description: '创建自己的工作簿与工作表' },
  { key: 'import_export', label: '导入 / 导出', description: 'Excel 导入与表格导出' },
  { key: 'use_trade_center', label: '外贸业务中心', description: '询价、报价、采购、发货流程' },
  { key: 'use_mail', label: '邮件', description: '收发工作邮件' },
  { key: 'use_channels', label: '频道', description: '团队频道与消息协作' },
  { key: 'admin_console', label: '管理后台', description: '用户、权限、系统配置' },
  { key: 'manage_users', label: '用户管理', description: '新增、禁用、重置用户' },
  { key: 'manage_roles', label: '角色管理', description: '维护角色与成员' },
  { key: 'manage_permissions', label: '权限配置', description: '工作表、行列、单元格权限' },
  { key: 'manage_departments', label: '部门管理', description: '部门与成员归属' },
  { key: 'manage_folders', label: '文件夹管理', description: '文件夹可见范围' },
  { key: 'manage_workbooks', label: '工作簿管理', description: '分配与回收工作簿' },
  { key: 'configure_ai', label: 'AI 配置', description: '模型、密钥与助手管理' },
  { key: 'configure_whatsapp', label: 'WhatsApp 配置', description: 'WhatsApp 账号与设置' },
  { key: 'configure_mail', label: '邮件服务配置', description: '邮箱账号与收件设置' },
  { key: 'manage_backup', label: '数据备份', description: '备份下载与恢复' },
  { key: 'manage_recycle_bin', label: '回收站管理', description: '恢复或彻底删除数据' },
]

const ACCESS_LABELS: Record<string, string> = {
  admin: '管理员权限',
  owner: '我创建的',
  granted: '被授权',
}

function summarizeSheets(sheets: SheetPermissionEntry[] | undefined) {
  const list = Array.isArray(sheets) ? sheets : []
  const editable = list.filter((sheet) => sheet.can_edit).length
  const viewable = list.filter((sheet) => sheet.can_view).length
  const restricted = list.filter((sheet) => (sheet.readonly_columns?.length ?? 0) > 0 || (sheet.hidden_columns?.length ?? 0) > 0).length
  return { total: list.length, editable, viewable, restricted }
}

export default function MyPermissionsCard() {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedWorkbookId, setExpandedWorkbookId] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await api.get<PermissionSnapshot>('/me/permissions')
        if (!active) return
        if (res.code !== 0 || !res.data) {
          setError(res.message || '无法加载权限信息。')
          return
        }
        setSnapshot(res.data)
      } catch {
        if (active) setError('无法加载权限信息。')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const granted = useMemo(() => {
    if (!snapshot) return []
    return FEATURE_LABELS.filter((feature) => snapshot.features?.[feature.key])
  }, [snapshot])

  const denied = useMemo(() => {
    if (!snapshot) return []
    return FEATURE_LABELS.filter((feature) => !snapshot.features?.[feature.key])
  }, [snapshot])

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <ShieldCheck className="h-5 w-5 text-sky-600" />
          我的权限
        </h2>
        {snapshot && (
          <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${snapshot.is_admin ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
            <Shield className="h-3.5 w-3.5" />
            {snapshot.is_admin ? '管理员账号' : '普通账号'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载权限信息…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : snapshot ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="text-slate-400">角色</span>
            {snapshot.role_names.length > 0
              ? snapshot.role_names.map((name, index) => (
                <span key={`${name}-${index}`} className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">{name}</span>
              ))
              : <span className="text-slate-400">未分配角色</span>}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">可使用的功能</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {granted.map((feature) => (
                <div key={feature.key} className="flex items-start gap-2 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-emerald-900">{feature.label}</div>
                    <div className="text-xs text-emerald-700/80">{feature.description}</div>
                  </div>
                </div>
              ))}
              {denied.map((feature) => (
                <div key={feature.key} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 opacity-70">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-500">{feature.label}</div>
                    <div className="text-xs text-slate-400">当前账号无权限，需要联系管理员开通</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">
              可访问的数据
              <span className="ml-2 text-xs font-normal text-slate-500">
                共 {snapshot.workbook_total} 个工作簿 · {snapshot.sheet_total} 张工作表
              </span>
            </h3>
            {snapshot.workbook_note && <p className="mb-2 text-xs text-slate-500">{snapshot.workbook_note}</p>}
            {snapshot.workbooks.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500">当前没有可访问的工作簿。</div>
            ) : (
              <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                {snapshot.workbooks.map((workbook) => {
                  const stats = summarizeSheets(workbook.sheets)
                  const expanded = expandedWorkbookId === workbook.workbook_id
                  return (
                    <div key={workbook.workbook_id}>
                      <button
                        type="button"
                        onClick={() => setExpandedWorkbookId(expanded ? null : workbook.workbook_id)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-slate-50"
                      >
                        <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-800">{workbook.workbook_name}</div>
                          <div className="truncate text-xs text-slate-500">
                            {ACCESS_LABELS[workbook.access_level || 'granted'] || '被授权'}
                            {workbook.owner_name ? ` · 负责人 ${workbook.owner_name}` : ''}
                            {` · ${stats.total} 张表，${stats.editable} 张可编辑`}
                            {stats.restricted > 0 ? ` · ${stats.restricted} 张表有列级限制` : ''}
                          </div>
                        </div>
                      </button>
                      {expanded && (
                        <div className="space-y-1 border-t border-slate-100 bg-slate-50/60 px-3 py-2">
                          {(workbook.sheets || []).map((sheet) => (
                            <div key={sheet.sheet_id} className="flex flex-wrap items-center gap-2 py-1 text-xs">
                              <span className="min-w-0 flex-1 truncate text-slate-700">{sheet.sheet_name}</span>
                              <span className={`rounded-full px-2 py-0.5 ${sheet.can_edit ? 'bg-emerald-100 text-emerald-700' : sheet.can_view ? 'bg-sky-100 text-sky-700' : 'bg-slate-200 text-slate-600'}`}>
                                {sheet.can_edit ? '可编辑' : sheet.can_view ? '只读' : '不可见'}
                              </span>
                              {sheet.can_export && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">可导出</span>}
                              {(sheet.readonly_columns?.length ?? 0) > 0 && (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">限制列 {sheet.readonly_columns?.length}</span>
                              )}
                              {(sheet.hidden_columns?.length ?? 0) > 0 && (
                                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">隐藏列 {sheet.hidden_columns?.length}</span>
                              )}
                            </div>
                          ))}
                          {(workbook.sheets || []).length === 0 && <div className="py-1 text-xs text-slate-400">没有可访问的工作表。</div>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {snapshot.note && <p className="mt-2 text-xs text-slate-500">{snapshot.note}</p>}
          </div>

          <p className="text-xs text-slate-400">同样的权限说明会提供给 AI 助手，助手只会执行当前账号允许的操作。</p>
        </div>
      ) : null}
    </div>
  )
}
