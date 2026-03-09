'use client'

import {
  ArrowLeft,
  Columns3,
  Eye,
  FileSpreadsheet,
  Lock,
  PencilLine,
  Save,
  Settings2,
  Share2,
  Shield,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import type { Workbook } from '@/types'

interface Role {
  id: number
  name: string
}

interface SheetOption {
  id: number
  name: string
  workbookName: string
}

interface SheetPermission {
  can_view: boolean
  can_edit: boolean
  can_delete: boolean
  can_export: boolean
}

interface ColumnPerm {
  column_key: string
  permission: 'read' | 'write' | 'none'
}

const defaultSheetPermission: SheetPermission = {
  can_view: false,
  can_edit: false,
  can_delete: false,
  can_export: false,
}

const sheetPermissionLabels: { key: keyof SheetPermission; label: string; icon: typeof Eye }[] = [
  { key: 'can_view', label: '查看', icon: Eye },
  { key: 'can_edit', label: '编辑', icon: PencilLine },
  { key: 'can_delete', label: '删除', icon: Trash2 },
  { key: 'can_export', label: '导出', icon: Share2 },
]

export default function PermissionsPage() {
  const [sheetOptions, setSheetOptions] = useState<SheetOption[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [selectedSheet, setSelectedSheet] = useState<number | null>(null)
  const [selectedRole, setSelectedRole] = useState<number | null>(null)
  const [sheetPermission, setSheetPermission] = useState<SheetPermission>(defaultSheetPermission)
  const [columnPerms, setColumnPerms] = useState<ColumnPerm[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Fetch workbooks (which contain sheets) and roles
  const fetchData = useCallback(async () => {
    try {
      const [wbRes, rolesRes] = await Promise.all([
        api.get<Workbook[]>('/workbooks'),
        api.get<Role[]>('/roles'),
      ])

      const workbooks = wbRes.code === 0 && wbRes.data ? wbRes.data : []
      const allSheets: SheetOption[] = []

      // Fetch each workbook's sheets
      for (const wb of workbooks) {
        const wbDetail = await api.get<Workbook>(`/workbooks/${wb.id}`)
        if (wbDetail.code === 0 && wbDetail.data?.sheets) {
          for (const s of wbDetail.data.sheets) {
            allSheets.push({ id: s.id, name: s.name, workbookName: wb.name })
          }
        }
      }

      setSheetOptions(allSheets)
      setRoles(rolesRes.code === 0 && rolesRes.data ? rolesRes.data : [])
    } catch (err) {
      console.error('Failed to fetch data:', err)
      setError('加载数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // When sheet+role are selected, fetch current permission matrix
  const fetchPermissions = useCallback(async () => {
    if (!selectedSheet || !selectedRole) return
    try {
      // GetPermissionMatrix is per-user, but we can use it to see current state
      // For admin config we read from the sheet permission endpoint
      const res = await api.get<{
        sheet: { canView: boolean; canEdit: boolean; canDelete: boolean; canExport: boolean }
        columns: Record<string, string>
        cells: Record<string, string>
      }>(`/sheets/${selectedSheet}/permissions`)

      if (res.code === 0 && res.data) {
        setSheetPermission({
          can_view: res.data.sheet.canView ?? false,
          can_edit: res.data.sheet.canEdit ?? false,
          can_delete: res.data.sheet.canDelete ?? false,
          can_export: res.data.sheet.canExport ?? false,
        })
        // Convert columns map to array
        const colEntries = Object.entries(res.data.columns || {})
        setColumnPerms(colEntries.map(([key, perm]) => ({
          column_key: key,
          permission: perm as 'read' | 'write' | 'none',
        })))
        return
      }
      setSheetPermission(defaultSheetPermission)
      setColumnPerms([])
    } catch {
      setSheetPermission(defaultSheetPermission)
      setColumnPerms([])
    }
  }, [selectedSheet, selectedRole])

  useEffect(() => { fetchPermissions() }, [fetchPermissions])

  const handleSaveSheetPermission = async () => {
    if (!selectedSheet || !selectedRole) return
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      // Backend uses POST /permissions/sheet with body { sheet_id, role_id, can_view, ... }
      await api.post('/permissions/sheet', {
        sheet_id: selectedSheet,
        role_id: selectedRole,
        ...sheetPermission,
      })
      setSuccess('工作表权限已保存')
      setTimeout(() => setSuccess(''), 2000)
    } catch (err) {
      console.error('Failed to save permissions:', err)
      setError('保存权限失败')
    } finally {
      setSaving(false)
    }
  }

  const handleColumnPermissionChange = (index: number, value: 'read' | 'write' | 'none') => {
    setColumnPerms((prev) => {
      const updated = [...prev]
      updated[index] = { ...updated[index], permission: value }
      return updated
    })
  }

  const handleSaveColumnPermission = async (col: ColumnPerm) => {
    if (!selectedSheet || !selectedRole) return
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      // Backend uses POST /permissions/cell with body { sheet_id, role_id, column_key, permission }
      await api.post('/permissions/cell', {
        sheet_id: selectedSheet,
        role_id: selectedRole,
        column_key: col.column_key,
        permission: col.permission,
      })
      setSuccess(`列 ${col.column_key} 权限已保存`)
      setTimeout(() => setSuccess(''), 2000)
    } catch (err) {
      console.error('Failed to save column permission:', err)
      setError('保存列权限失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAllColumnPermissions = async () => {
    if (!selectedSheet || !selectedRole || columnPerms.length === 0) return
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      for (const col of columnPerms) {
        await api.post('/permissions/cell', {
          sheet_id: selectedSheet,
          role_id: selectedRole,
          column_key: col.column_key,
          permission: col.permission,
        })
      }
      setSuccess('全部列权限已保存')
      setTimeout(() => setSuccess(''), 2000)
    } catch (err) {
      console.error('Failed to save column permissions:', err)
      setError('保存列权限失败')
    } finally {
      setSaving(false)
    }
  }

  const selectedSheetName = sheetOptions.find((s) => s.id === selectedSheet)?.name
  const selectedRoleName = roles.find((r) => r.id === selectedRole)?.name

  return (
    <AuthGuard requireRole="admin">
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.18),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-4 p-3 md:p-6">
          {/* Header */}
          <header className="overflow-hidden rounded-[32px] border border-white/70 bg-white/80 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.7)] backdrop-blur">
            <div className="flex flex-col gap-6 px-4 py-5 md:px-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-4">
                <a href="/" className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900">
                  <ArrowLeft className="h-4 w-4" />
                  返回工作台
                </a>
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
                    <Settings2 className="h-3.5 w-3.5" />
                    Admin Permissions
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">权限矩阵配置</h1>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">为每个角色精确控制工作表和列级别的访问权限。</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[460px]">
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white"><FileSpreadsheet className="h-4 w-4" /></div>
                  <div className="text-sm text-slate-500">工作表</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{sheetOptions.length}</div>
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-100 text-sky-700"><Shield className="h-4 w-4" /></div>
                  <div className="text-sm text-slate-500">角色</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{roles.length}</div>
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-700"><Lock className="h-4 w-4" /></div>
                  <div className="text-sm text-slate-500">配置状态</div>
                  <div className="mt-1 text-lg font-semibold text-slate-950">{selectedSheet && selectedRole ? '配置中' : '待选择'}</div>
                </div>
              </div>
            </div>
          </header>

          {/* Feedback */}
          {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
          {success && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">{success}</div>}

          {/* Selector */}
          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="mb-5">
              <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Selector</div>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">选择配置目标</h2>
              <p className="mt-2 text-sm text-slate-500">选择一张工作表和一个角色，系统会自动加载该组合下的权限设置。</p>
            </div>
            {loading ? (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center text-slate-500">正在加载...</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">工作表</label>
                  <select
                    value={selectedSheet ?? ''}
                    onChange={(e) => setSelectedSheet(e.target.value ? Number(e.target.value) : null)}
                    className="h-11 w-full appearance-none rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  >
                    <option value="">-- 请选择工作表 --</option>
                    {sheetOptions.map((s) => (
                      <option key={s.id} value={s.id}>{s.workbookName} / {s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">角色</label>
                  <select
                    value={selectedRole ?? ''}
                    onChange={(e) => setSelectedRole(e.target.value ? Number(e.target.value) : null)}
                    className="h-11 w-full appearance-none rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  >
                    <option value="">-- 请选择角色 --</option>
                    {roles.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
                  </select>
                </div>
              </div>
            )}
          </section>

          {selectedSheet && selectedRole ? (
            <>
              {/* Sheet Permissions */}
              <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Sheet Permissions</div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">工作表级别权限</h2>
                    <p className="mt-2 text-sm text-slate-500">
                      当前配置：<span className="font-medium text-slate-700">{selectedSheetName}</span> / <span className="font-medium text-slate-700">{selectedRoleName}</span>
                    </p>
                  </div>
                  <button type="button" onClick={handleSaveSheetPermission} disabled={saving} className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                    <Save className="h-4 w-4" />
                    {saving ? '保存中...' : '保存工作表权限'}
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {sheetPermissionLabels.map(({ key, label, icon: Icon }) => (
                    <label key={key} className={`group flex cursor-pointer items-center gap-3 rounded-[22px] border p-4 transition ${sheetPermission[key] ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white'}`}>
                      <div className={`flex h-10 w-10 items-center justify-center rounded-2xl transition ${sheetPermission[key] ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-400 group-hover:bg-slate-200'}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1">
                        <div className={`text-sm font-semibold ${sheetPermission[key] ? 'text-sky-800' : 'text-slate-700'}`}>{label}</div>
                        <div className="text-xs text-slate-400">{sheetPermission[key] ? '已开启' : '未开启'}</div>
                      </div>
                      <input type="checkbox" checked={sheetPermission[key]} onChange={(e) => setSheetPermission({ ...sheetPermission, [key]: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500" />
                    </label>
                  ))}
                </div>
              </section>

              {/* Column Permissions */}
              <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Column Permissions</div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">列级别权限</h2>
                    <p className="mt-2 text-sm text-slate-500">对每一列单独控制 read / write / none 权限。</p>
                  </div>
                  {columnPerms.length > 0 && (
                    <button type="button" onClick={handleSaveAllColumnPermissions} disabled={saving} className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                      <Save className="h-4 w-4" />
                      {saving ? '保存中...' : '保存全部列权限'}
                    </button>
                  )}
                </div>
                {columnPerms.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center">
                    <Columns3 className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                    <h3 className="text-lg font-semibold text-slate-600">暂无列权限配置</h3>
                    <p className="mt-2 text-sm text-slate-400">需先在工作表中添加数据列。</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
                            <th className="px-4 py-3 text-left font-semibold">列名</th>
                            <th className="px-4 py-3 text-center font-semibold">权限</th>
                            <th className="px-4 py-3 text-right font-semibold">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {columnPerms.map((col, idx) => (
                            <tr key={col.column_key} className="hover:bg-slate-50/80">
                              <td className="px-4 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500"><Columns3 className="h-3.5 w-3.5" /></div>
                                  <span className="font-medium text-slate-900">{col.column_key}</span>
                                </div>
                              </td>
                              <td className="px-4 py-4 text-center">
                                <select
                                  value={col.permission}
                                  onChange={(e) => handleColumnPermissionChange(idx, e.target.value as 'read' | 'write' | 'none')}
                                  className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                                >
                                  <option value="none">禁止访问</option>
                                  <option value="read">只读</option>
                                  <option value="write">可编辑</option>
                                </select>
                              </td>
                              <td className="px-4 py-4 text-right">
                                <button type="button" onClick={() => handleSaveColumnPermission(col)} disabled={saving} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                                  保存
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            </>
          ) : !loading ? (
            <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center">
                <Settings2 className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                <h3 className="text-2xl font-semibold text-slate-950">请先选择配置目标</h3>
                <p className="mt-3 text-sm text-slate-500">在上方选择一张工作表和一个角色后，即可配置权限。</p>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </AuthGuard>
  )
}
