'use client'

import {
  ArrowLeft,
  PencilLine,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'

interface Role {
  id: number
  name: string
  code: string
  description: string
}

export default function RolesManagementPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newRole, setNewRole] = useState({ name: '', code: '', description: '' })
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [editForm, setEditForm] = useState({ name: '', description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const fetchRoles = useCallback(async () => {
    try {
      const res = await api.get<Role[]>('/roles')
      if (res.code === 0 && res.data) {
        setRoles(res.data)
      }
    } catch (err) {
      console.error('Failed to fetch roles:', err)
      setError('加载角色列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRoles()
  }, [fetchRoles])

  const handleCreate = async () => {
    if (!newRole.name.trim() || !newRole.code.trim()) {
      setError('角色名称和角色代码为必填项')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const res = await api.post('/roles', {
        name: newRole.name.trim(),
        code: newRole.code.trim(),
        description: newRole.description.trim(),
      })
      if (res.code !== 0) {
        setError(res.message || '创建角色失败')
        return
      }
      setNewRole({ name: '', code: '', description: '' })
      setShowCreateForm(false)
      await fetchRoles()
    } catch (err) {
      console.error('Failed to create role:', err)
      setError('创建角色失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleEdit = (role: Role) => {
    setEditingRole(role)
    setEditForm({ name: role.name, description: role.description || '' })
  }

  const handleUpdate = async () => {
    if (!editingRole || !editForm.name.trim()) {
      setError('角色名称不能为空')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const res = await api.put(`/roles/${editingRole.id}`, {
        name: editForm.name.trim(),
        description: editForm.description.trim(),
      })
      if (res.code !== 0) {
        setError(res.message || '更新角色失败')
        return
      }
      setEditingRole(null)
      await fetchRoles()
    } catch (err) {
      console.error('Failed to update role:', err)
      setError('更新角色失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (roleId: number) => {
    if (!confirm('确定要删除此角色吗？删除后相关用户的角色绑定也会失效。')) return

    setSubmitting(true)
    setError('')
    try {
      const res = await api.delete(`/roles/${roleId}`)
      if (res.code !== 0) {
        setError(res.message || '删除角色失败')
        return
      }
      await fetchRoles()
    } catch (err) {
      console.error('Failed to delete role:', err)
      setError('删除角色失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthGuard requireRole="admin">
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.18),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-4 p-3 md:p-6">
          {/* Header */}
          <header className="overflow-hidden rounded-[32px] border border-white/70 bg-white/80 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.7)] backdrop-blur">
            <div className="flex flex-col gap-6 px-4 py-5 md:px-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-4">
                <a
                  href="/"
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
                >
                  <ArrowLeft className="h-4 w-4" />
                  返回工作台
                </a>
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Admin Roles
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                    角色管理
                  </h1>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                    管理系统中的角色定义，角色创建后可在员工账号管理中分配给用户，再通过权限矩阵控制各角色的数据访问能力。
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[340px]">
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div className="text-sm text-slate-500">角色总数</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{roles.length}</div>
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div className="text-sm text-slate-500">系统角色</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">
                    {roles.filter((r) => r.code === 'admin').length}
                  </div>
                </div>
              </div>
            </div>
          </header>

          {/* Create Section */}
          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Role Management
                </div>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">新建角色</h2>
                <p className="mt-2 text-sm text-slate-500">
                  角色代码(code)用于系统内部标识，建议使用英文小写，例如 editor、viewer。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateForm((prev) => !prev)}
                className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                {showCreateForm ? '收起表单' : '新建角色'}
              </button>
            </div>

            {showCreateForm && (
              <div className="mt-5 rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.98))] p-5 shadow-sm">
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">角色名称 *</label>
                    <input
                      type="text"
                      value={newRole.name}
                      onChange={(e) => setNewRole((prev) => ({ ...prev, name: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="例如：编辑者"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">角色代码 *</label>
                    <input
                      type="text"
                      value={newRole.code}
                      onChange={(e) => setNewRole((prev) => ({ ...prev, code: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="例如：editor"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">描述</label>
                    <input
                      type="text"
                      value={newRole.description}
                      onChange={(e) => setNewRole((prev) => ({ ...prev, description: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="可选，描述角色用途"
                    />
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Plus className="h-4 w-4" />
                    {submitting ? '创建中...' : '创建角色'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Roles List */}
          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Directory
                </div>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">角色列表</h2>
              </div>
            </div>

            {error && (
              <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            {loading ? (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center text-slate-500">
                正在加载角色列表...
              </div>
            ) : roles.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.98))] px-6 py-14 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-slate-900 text-white">
                  <Shield className="h-7 w-7" />
                </div>
                <h3 className="text-2xl font-semibold text-slate-950">还没有角色</h3>
                <p className="mt-3 text-sm leading-7 text-slate-500">
                  先创建角色，再到员工管理中分配给对应用户。
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">角色</th>
                        <th className="px-4 py-3 text-left font-semibold">代码</th>
                        <th className="px-4 py-3 text-left font-semibold">描述</th>
                        <th className="px-4 py-3 text-right font-semibold">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {roles.map((role) => (
                        <tr key={role.id} className="hover:bg-slate-50/80">
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                                <Shield className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="font-semibold text-slate-900">{role.name}</div>
                                <div className="text-xs text-slate-400">ID #{role.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                              {role.code}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-slate-600">{role.description || '-'}</td>
                          <td className="px-4 py-4 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleEdit(role)}
                                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                              >
                                <PencilLine className="h-3.5 w-3.5" />
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(role.id)}
                                disabled={submitting}
                                className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          {/* Edit Dialog */}
          {editingRole && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm">
              <div className="w-full max-w-lg rounded-[28px] border border-white/70 bg-white p-6 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.75)] md:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                      Edit Role
                    </div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                      编辑角色：{editingRole.name}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingRole(null)}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    关闭
                  </button>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">角色名称</label>
                    <input
                      type="text"
                      value={editForm.name}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">描述</label>
                    <input
                      type="text"
                      value={editForm.description}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, description: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    />
                  </div>
                </div>

                <div className="mt-8 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingRole(null)}
                    className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleUpdate}
                    disabled={submitting}
                    className="rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? '保存中...' : '保存修改'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  )
}
