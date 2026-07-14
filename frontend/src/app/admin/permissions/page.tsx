'use client'

import {
  Columns3,
  Eye,
  FileSpreadsheet,
  Lock,
  PencilLine,
  Rows3,
  Save,
  Settings2,
  Share2,
  Shield,
  Square,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import type { PageData, User, Workbook } from '@/types'

interface Role {
  id: number
  name: string
}

interface SheetOption {
  id: number
  name: string
  workbookName: string
  columns: string[]
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

interface RowPerm {
  row_index: number
  permission: 'read' | 'write' | 'none'
}

interface CellPerm {
  row_index: number
  column_key: string
  permission: 'read' | 'write' | 'none'
}

interface UserSheetPermission {
  user_id: number
  can_view: boolean
  can_edit: boolean
  can_delete: boolean
  can_export: boolean
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

const permissionOptions: Array<{ value: 'none' | 'read' | 'write'; label: string }> = [
  { value: 'none', label: '禁止访问' },
  { value: 'read', label: '只读' },
  { value: 'write', label: '可编辑' },
]

const dataRowToDisplayRow = (rowIndex: number) => Math.max(1, rowIndex + 2)
const displayRowToDataRow = (displayRow: number) => Math.max(0, displayRow - 2)

export default function PermissionsPage() {
  const [sheetOptions, setSheetOptions] = useState<SheetOption[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [selectedSheet, setSelectedSheet] = useState<number | null>(null)
  const [selectedRole, setSelectedRole] = useState<number | null>(null)
  const [sheetPermission, setSheetPermission] = useState<SheetPermission>(defaultSheetPermission)
  const [columnPerms, setColumnPerms] = useState<ColumnPerm[]>([])
  const [rowPerms, setRowPerms] = useState<RowPerm[]>([])
  const [cellPerms, setCellPerms] = useState<CellPerm[]>([])
  const [rowPermDraft, setRowPermDraft] = useState<RowPerm>({ row_index: 0, permission: 'read' })
  const [cellPermDraft, setCellPermDraft] = useState<CellPerm>({ row_index: 0, column_key: '', permission: 'read' })
  const [userPerms, setUserPerms] = useState<UserSheetPermission[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Fetch workbooks (which contain sheets) and roles
  const fetchData = useCallback(async () => {
    try {
      const [wbRes, rolesRes, usersRes] = await Promise.all([
        api.get<Workbook[]>('/workbooks'),
        api.get<Role[]>('/roles'),
        api.get<PageData<User>>('/users?page=1&size=500'),
      ])

      const workbooks = wbRes.code === 0 && wbRes.data ? wbRes.data : []
      const allSheets: SheetOption[] = []

      // Fetch each workbook's sheets
      for (const wb of workbooks) {
        const wbDetail = await api.get<Workbook>(`/workbooks/${wb.id}`)
        if (wbDetail.code === 0 && wbDetail.data?.sheets) {
          for (const s of wbDetail.data.sheets) {
            allSheets.push({
              id: s.id,
              name: s.name,
              workbookName: wb.name,
              columns: Array.isArray(s.columns) ? s.columns.map((column) => column.key) : [],
            })
          }
        }
      }

      setSheetOptions(allSheets)
      setRoles(rolesRes.code === 0 && rolesRes.data ? rolesRes.data : [])
      setUsers(
        usersRes.code === 0 && usersRes.data
          ? usersRes.data.list.filter((user) => user.status === 1 && !user.roles?.some((role) => role.code === 'admin'))
          : []
      )
    } catch (err) {
      console.error('Failed to fetch data:', err)
      setError('加载数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    if (selectedSheet && !selectedRole && roles.length > 0) {
      setSelectedRole(roles[0].id)
    }
  }, [roles, selectedRole, selectedSheet])

  // When sheet+role are selected, fetch current permission matrix
  const fetchPermissions = useCallback(async () => {
    if (!selectedSheet || !selectedRole) return
    try {
      const [roleRes, userRes] = await Promise.all([
        api.get<{
          sheet: { canView: boolean; canEdit: boolean; canDelete: boolean; canExport: boolean }
          rows?: Record<string, string>
          columns: Record<string, string>
          cells: Record<string, string>
        }>(`/permissions/sheets/${selectedSheet}/roles/${selectedRole}`),
        api.get<UserSheetPermission[]>(`/permissions/sheets/${selectedSheet}/users`),
      ])

      if (roleRes.code === 0 && roleRes.data) {
        const selectedSheetOption = sheetOptions.find((item) => item.id === selectedSheet)
        const availableColumns = selectedSheetOption?.columns || []
        setSheetPermission({
          can_view: roleRes.data.sheet.canView ?? false,
          can_edit: roleRes.data.sheet.canEdit ?? false,
          can_delete: roleRes.data.sheet.canDelete ?? false,
          can_export: roleRes.data.sheet.canExport ?? false,
        })
        setColumnPerms(
          availableColumns.map((key) => ({
            column_key: key,
            permission: (roleRes.data?.columns?.[key] as 'read' | 'write' | 'none' | undefined) || 'none',
          }))
        )
        setRowPerms(
          Object.entries(roleRes.data.rows || {})
            .map(([row, permission]) => ({
              row_index: Number(row),
              permission: permission as 'read' | 'write' | 'none',
            }))
            .filter((item) => Number.isFinite(item.row_index))
            .sort((a, b) => a.row_index - b.row_index)
        )
        setCellPerms(
          Object.entries(roleRes.data.cells || {})
            .map(([key, permission]) => {
              const [row, columnKey] = key.split(':')
              return {
                row_index: Number(row),
                column_key: columnKey || '',
                permission: permission as 'read' | 'write' | 'none',
              }
            })
            .filter((item) => Number.isFinite(item.row_index) && item.column_key)
            .sort((a, b) => a.row_index - b.row_index || a.column_key.localeCompare(b.column_key))
        )
        setCellPermDraft((prev) => ({ ...prev, column_key: prev.column_key || availableColumns[0] || '' }))
      } else {
        setSheetPermission(defaultSheetPermission)
        setColumnPerms([])
        setRowPerms([])
        setCellPerms([])
      }

      const directPerms = userRes.code === 0 && userRes.data ? userRes.data : []
      setUserPerms(
        users.map((user) => {
          const matched = directPerms.find((perm) => perm.user_id === user.id)
          return {
            user_id: user.id,
            can_view: matched?.can_view ?? false,
            can_edit: matched?.can_edit ?? false,
            can_delete: matched?.can_delete ?? false,
            can_export: matched?.can_export ?? false,
          }
        })
      )
    } catch {
      setSheetPermission(defaultSheetPermission)
      setColumnPerms([])
      setRowPerms([])
      setCellPerms([])
      setUserPerms([])
    }
  }, [selectedSheet, selectedRole, sheetOptions, users])

  useEffect(() => { fetchPermissions() }, [fetchPermissions])

  useEffect(() => {
    if (!selectedSheet) return
    const columns = sheetOptions.find((item) => item.id === selectedSheet)?.columns || []
    if (columns.length > 0 && !columns.includes(cellPermDraft.column_key)) {
      setCellPermDraft((prev) => ({ ...prev, column_key: columns[0] }))
    }
  }, [cellPermDraft.column_key, selectedSheet, sheetOptions])

  const handleSaveSheetPermission = async () => {
    if (!selectedSheet || !selectedRole) return
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await api.post('/permissions/sheet', {
        sheet_id: selectedSheet,
        role_id: selectedRole,
        ...sheetPermission,
      })
      await fetchPermissions()
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
      await api.post('/permissions/cell', {
        sheet_id: selectedSheet,
        role_id: selectedRole,
        column_key: col.column_key,
        permission: col.permission,
      })
      await fetchPermissions()
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
      await fetchPermissions()
      setSuccess('全部列权限已保存')
      setTimeout(() => setSuccess(''), 2000)
    } catch (err) {
      console.error('Failed to save column permissions:', err)
      setError('保存列权限失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveRowPermission = async (perm: RowPerm) => {
    if (!selectedSheet || !selectedRole) return
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await api.post('/permissions/cell', {
        sheet_id: selectedSheet,
        role_id: selectedRole,
        row_index: perm.row_index,
        column_key: '',
        permission: perm.permission,
      })
      await fetchPermissions()
      setSuccess(`第 ${dataRowToDisplayRow(perm.row_index)} 行权限已保存`)
      setTimeout(() => setSuccess(''), 2000)
    } catch (err) {
      console.error('Failed to save row permission:', err)
      setError('保存行权限失败')
    } finally {
      setSaving(false)
    }
  }

  const handleAddRowPermission = async () => {
    await handleSaveRowPermission(rowPermDraft)
  }

  const handleRowPermissionChange = (rowIndex: number, permission: 'read' | 'write' | 'none') => {
    setRowPerms((prev) => prev.map((item) => (item.row_index === rowIndex ? { ...item, permission } : item)))
  }

  const handleSaveCellPermission = async (perm: CellPerm) => {
    if (!selectedSheet || !selectedRole || !perm.column_key) return
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await api.post('/permissions/cell', {
        sheet_id: selectedSheet,
        role_id: selectedRole,
        row_index: perm.row_index,
        column_key: perm.column_key,
        permission: perm.permission,
      })
      await fetchPermissions()
      setSuccess(`${perm.column_key}${dataRowToDisplayRow(perm.row_index)} 权限已保存`)
      setTimeout(() => setSuccess(''), 2000)
    } catch (err) {
      console.error('Failed to save cell permission:', err)
      setError('保存单元格权限失败')
    } finally {
      setSaving(false)
    }
  }

  const handleAddCellPermission = async () => {
    await handleSaveCellPermission(cellPermDraft)
  }

  const handleCellPermissionChange = (rowIndex: number, columnKey: string, permission: 'read' | 'write' | 'none') => {
    setCellPerms((prev) =>
      prev.map((item) =>
        item.row_index === rowIndex && item.column_key === columnKey ? { ...item, permission } : item
      )
    )
  }

  const handleUserPermissionChange = (userId: number, key: keyof SheetPermission, value: boolean) => {
	setUserPerms((prev) =>
	  prev.map((perm) =>
	    perm.user_id === userId
	      ? {
	          ...perm,
	          [key]: value,
	          ...(key !== 'can_view' && value ? { can_view: true } : {}),
	        }
	      : perm
	  )
	)
  }

  const handleSaveUserPermission = async (perm: UserSheetPermission) => {
	if (!selectedSheet) return
	setSaving(true)
	setError('')
	setSuccess('')
	try {
	  await api.post('/permissions/user-sheet', {
	    sheet_id: selectedSheet,
	    ...perm,
	  })
	  await fetchPermissions()
	  const user = users.find((item) => item.id === perm.user_id)
	  setSuccess(`用户 ${user?.username || `#${perm.user_id}`} 的工作表权限已保存`)
	  setTimeout(() => setSuccess(''), 2000)
	} catch (err) {
	  console.error('Failed to save direct user permission:', err)
	  setError('保存用户权限失败')
	} finally {
	  setSaving(false)
	}
  }

  const handleSaveAllUserPermissions = async () => {
	if (!selectedSheet || userPerms.length === 0) return
	setSaving(true)
	setError('')
	setSuccess('')
	try {
	  for (const perm of userPerms) {
	    await api.post('/permissions/user-sheet', {
	      sheet_id: selectedSheet,
	      ...perm,
	    })
	  }
	  await fetchPermissions()
	  setSuccess('全部指定用户权限已保存')
	  setTimeout(() => setSuccess(''), 2000)
	} catch (err) {
	  console.error('Failed to save direct user permissions:', err)
	  setError('保存用户权限失败')
	} finally {
	  setSaving(false)
	}
  }

  const selectedSheetName = sheetOptions.find((s) => s.id === selectedSheet)?.name
  const selectedRoleName = roles.find((r) => r.id === selectedRole)?.name
  const selectedSheetColumns = sheetOptions.find((s) => s.id === selectedSheet)?.columns || []

  return (
    <AdminShell
      title="权限矩阵配置"
      description="为角色配置工作表、行列和字段级访问权限"
      summary={(
        <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white"><FileSpreadsheet className="h-4 w-4" /></div>
                  <div className="text-sm text-slate-500">工作表</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{sheetOptions.length}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-100 text-sky-700"><Shield className="h-4 w-4" /></div>
                  <div className="text-sm text-slate-500">角色</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{roles.length}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-700"><Lock className="h-4 w-4" /></div>
                  <div className="text-sm text-slate-500">配置状态</div>
                  <div className="mt-1 text-lg font-semibold text-slate-950">{selectedSheet && selectedRole ? '配置中' : '待选择'}</div>
                </div>
        </div>
      )}
    >

          {/* Feedback */}
          {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
          {success && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">{success}</div>}

          {/* Selector */}
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
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
              <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
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
              <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
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

              <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
                <div className="mb-5">
                  <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Row Permissions</div>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-950">行级别权限</h2>
                  <p className="mt-2 text-sm text-slate-500">按工作表显示行号控制整行权限；单元格权限优先级高于行权限。</p>
                </div>
                <div className="mb-4 grid gap-3 rounded-[24px] border border-slate-200 bg-slate-50/80 p-4 md:grid-cols-[1fr_1fr_auto]">
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold text-slate-600">显示行号</span>
                    <input
                      type="number"
                      min={2}
                      value={dataRowToDisplayRow(rowPermDraft.row_index)}
                      onChange={(event) => setRowPermDraft((prev) => ({ ...prev, row_index: displayRowToDataRow(Number(event.target.value) || 2) }))}
                      className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold text-slate-600">权限</span>
                    <select
                      value={rowPermDraft.permission}
                      onChange={(event) => setRowPermDraft((prev) => ({ ...prev, permission: event.target.value as RowPerm['permission'] }))}
                      className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                    >
                      {permissionOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={handleAddRowPermission}
                    disabled={saving}
                    className="self-end rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    保存行权限
                  </button>
                </div>
                {rowPerms.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-10 text-center">
                    <Rows3 className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                    <h3 className="text-lg font-semibold text-slate-600">暂无行级权限</h3>
                    <p className="mt-2 text-sm text-slate-400">添加后会覆盖该行的工作表/列级权限。</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">行</th>
                          <th className="px-4 py-3 text-center font-semibold">权限</th>
                          <th className="px-4 py-3 text-right font-semibold">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rowPerms.map((perm) => (
                          <tr key={perm.row_index} className="hover:bg-slate-50/80">
                            <td className="px-4 py-4 font-medium text-slate-900">第 {dataRowToDisplayRow(perm.row_index)} 行</td>
                            <td className="px-4 py-4 text-center">
                              <select
                                value={perm.permission}
                                onChange={(event) => handleRowPermissionChange(perm.row_index, event.target.value as RowPerm['permission'])}
                                className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                              >
                                {permissionOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <button type="button" onClick={() => handleSaveRowPermission(perm)} disabled={saving} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                                保存
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
                <div className="mb-5">
                  <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Cell Permissions</div>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-950">单元格级别权限</h2>
                  <p className="mt-2 text-sm text-slate-500">单元格权限优先级最高，可覆盖工作表、列和行级规则。</p>
                </div>
                <div className="mb-4 grid gap-3 rounded-[24px] border border-slate-200 bg-slate-50/80 p-4 md:grid-cols-[1fr_1fr_1fr_auto]">
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold text-slate-600">显示行号</span>
                    <input
                      type="number"
                      min={2}
                      value={dataRowToDisplayRow(cellPermDraft.row_index)}
                      onChange={(event) => setCellPermDraft((prev) => ({ ...prev, row_index: displayRowToDataRow(Number(event.target.value) || 2) }))}
                      className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold text-slate-600">列</span>
                    <select
                      value={cellPermDraft.column_key || selectedSheetColumns[0] || ''}
                      onChange={(event) => setCellPermDraft((prev) => ({ ...prev, column_key: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                    >
                      {selectedSheetColumns.map((columnKey) => (
                        <option key={columnKey} value={columnKey}>{columnKey}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold text-slate-600">权限</span>
                    <select
                      value={cellPermDraft.permission}
                      onChange={(event) => setCellPermDraft((prev) => ({ ...prev, permission: event.target.value as CellPerm['permission'] }))}
                      className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                    >
                      {permissionOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={handleAddCellPermission}
                    disabled={saving || selectedSheetColumns.length === 0}
                    className="self-end rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    保存单元格权限
                  </button>
                </div>
                {cellPerms.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-10 text-center">
                    <Square className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                    <h3 className="text-lg font-semibold text-slate-600">暂无单元格权限</h3>
                    <p className="mt-2 text-sm text-slate-400">添加后会优先覆盖其它级别的权限。</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">单元格</th>
                          <th className="px-4 py-3 text-center font-semibold">权限</th>
                          <th className="px-4 py-3 text-right font-semibold">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {cellPerms.map((perm) => (
                          <tr key={`${perm.row_index}:${perm.column_key}`} className="hover:bg-slate-50/80">
                            <td className="px-4 py-4 font-medium text-slate-900">{perm.column_key}{dataRowToDisplayRow(perm.row_index)}</td>
                            <td className="px-4 py-4 text-center">
                              <select
                                value={perm.permission}
                                onChange={(event) => handleCellPermissionChange(perm.row_index, perm.column_key, event.target.value as CellPerm['permission'])}
                                className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                              >
                                {permissionOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <button type="button" onClick={() => handleSaveCellPermission(perm)} disabled={saving} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                                保存
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">User Permissions</div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">指定用户权限</h2>
                    <p className="mt-2 text-sm text-slate-500">直接指定哪些员工可以查看、编辑、删除或导出当前工作表。这里的设置会在角色权限基础上额外叠加。</p>
                  </div>
                  {userPerms.length > 0 && (
                    <button type="button" onClick={handleSaveAllUserPermissions} disabled={saving} className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                      <Save className="h-4 w-4" />
                      {saving ? '保存中...' : '保存全部用户权限'}
                    </button>
                  )}
                </div>
                {userPerms.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center">
                    <Shield className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                    <h3 className="text-lg font-semibold text-slate-600">暂无可配置的员工</h3>
                    <p className="mt-2 text-sm text-slate-400">请先在员工管理里创建并启用员工账号。</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
                            <th className="px-4 py-3 text-left font-semibold">用户</th>
                            {sheetPermissionLabels.map(({ key, label }) => (
                              <th key={key} className="px-4 py-3 text-center font-semibold">{label}</th>
                            ))}
                            <th className="px-4 py-3 text-right font-semibold">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {userPerms.map((perm) => {
                            const user = users.find((item) => item.id === perm.user_id)

                            return (
                              <tr key={perm.user_id} className="hover:bg-slate-50/80">
                                <td className="px-4 py-4">
                                  <div className="flex items-center gap-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                                      <Shield className="h-3.5 w-3.5" />
                                    </div>
                                    <div>
                                      <div className="font-medium text-slate-900">{user?.username || `用户 #${perm.user_id}`}</div>
                                      <div className="text-xs text-slate-400">{user?.email || '未找到邮箱'}</div>
                                    </div>
                                  </div>
                                </td>
                                {sheetPermissionLabels.map(({ key }) => (
                                  <td key={key} className="px-4 py-4 text-center">
                                    <input
                                      type="checkbox"
                                      checked={perm[key]}
                                      onChange={(event) => handleUserPermissionChange(perm.user_id, key, event.target.checked)}
                                      className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                                    />
                                  </td>
                                ))}
                                <td className="px-4 py-4 text-right">
                                  <button type="button" onClick={() => handleSaveUserPermission(perm)} disabled={saving} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                                    保存
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            </>
          ) : !loading ? (
            <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center">
                <Settings2 className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                <h3 className="text-2xl font-semibold text-slate-950">请先选择配置目标</h3>
                <p className="mt-3 text-sm text-slate-500">在上方选择一张工作表和一个角色后，即可配置权限。</p>
              </div>
            </section>
          ) : null}
    </AdminShell>
  )
}
