'use client'

import {
  ArrowLeft,
  BadgeCheck,
  Mail,
  PencilLine,
  Plus,
  ShieldCheck,
  Trash2,
  UserRound,
  UserRoundPlus,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type { AuthUser, PageData, Role } from '@/types'

interface CreateUserForm {
  username: string
  email: string
  password: string
  roleIds: number[]
}

export default function UsersManagementPage() {
  const currentUser = getStoredUser()
  const [users, setUsers] = useState<AuthUser[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null)
  const [editForm, setEditForm] = useState({ email: '', isActive: true })
  const [selectedRoles, setSelectedRoles] = useState<number[]>([])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createForm, setCreateForm] = useState<CreateUserForm>({
    username: '',
    email: '',
    password: '',
    roleIds: [],
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get<PageData<AuthUser>>('/users?page=1&size=100')
      if (res.code === 0 && res.data) {
        setUsers(Array.isArray(res.data.list) ? res.data.list : [])
      }
    } catch (err) {
      console.error('Failed to fetch users:', err)
      setError('加载员工账号失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchRoles = useCallback(async () => {
    try {
      const res = await api.get<Role[]>('/roles')
      if (res.code === 0 && res.data) {
        setRoles(res.data)
      }
    } catch (err) {
      console.error('Failed to fetch roles:', err)
      setError('加载角色列表失败')
    }
  }, [])

  useEffect(() => {
    fetchUsers()
    fetchRoles()
  }, [fetchRoles, fetchUsers])

  const handleEdit = (user: AuthUser) => {
    setEditingUser(user)
    setEditForm({ email: user.email || '', isActive: user.status === 1 })
    setSelectedRoles(user.roles.map((role) => role.id))
  }

  const handleSave = async () => {
    if (!editingUser) return

    setSubmitting(true)
    setError('')
    try {
      await api.put(`/users/${editingUser.id}`, {
        email: editForm.email,
        status: editForm.isActive ? 1 : 0,
      })
      await api.post(`/users/${editingUser.id}/roles`, {
        roles: selectedRoles,
      })
      setEditingUser(null)
      await fetchUsers()
    } catch (err) {
      console.error('Failed to update user:', err)
      setError('保存员工信息失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCreate = async () => {
    if (!createForm.username.trim() || !createForm.email.trim() || !createForm.password.trim()) {
      setError('请填写用户名、邮箱和初始密码')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const registerRes = await api.post('/auth/register', {
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        password: createForm.password,
      })

      if (registerRes.code !== 0) {
        setError(registerRes.message || '创建员工账号失败')
        return
      }

      const usersRes = await api.get<PageData<AuthUser>>('/users?page=1&size=100')
      const createdUsers = usersRes.code === 0 && usersRes.data ? usersRes.data.list : []
      const createdUser = createdUsers.find((user) => user.username === createForm.username.trim())

      if (createdUser && createForm.roleIds.length > 0) {
        await api.post(`/users/${createdUser.id}/roles`, { roles: createForm.roleIds })
      }

      setCreateForm({ username: '', email: '', password: '', roleIds: [] })
      setShowCreateForm(false)
      await fetchUsers()
    } catch (err) {
      console.error('Failed to create user:', err)
      setError('创建员工账号失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (userId: number) => {
    if (userId === currentUser?.id) {
      setError('不能删除当前登录的管理员账号')
      return
    }

    if (!confirm('确定要删除此员工账号吗？')) return

    setSubmitting(true)
    setError('')
    try {
      await api.delete(`/users/${userId}`)
      await fetchUsers()
    } catch (err) {
      console.error('Failed to delete user:', err)
      setError('删除员工账号失败')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleRole = (roleId: number, mode: 'create' | 'edit') => {
    const update = (prev: number[]) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]

    if (mode === 'create') {
      setCreateForm((prev) => ({ ...prev, roleIds: update(prev.roleIds) }))
      return
    }

    setSelectedRoles((prev) => update(prev))
  }

  const activeUsers = users.filter((user) => user.status === 1).length

  return (
    <AuthGuard requireRole="admin">
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.18),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-4 p-3 md:p-6">
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
                    Admin Users
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                    员工账号管理
                  </h1>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                    管理员可以在这里统一创建员工账号、停用账号、分配角色，并为后续权限矩阵配置做好基础准备。
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[460px]">
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                    <UserRound className="h-4 w-4" />
                  </div>
                  <div className="text-sm text-slate-500">员工总数</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{users.length}</div>
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                    <BadgeCheck className="h-4 w-4" />
                  </div>
                  <div className="text-sm text-slate-500">启用账号</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{activeUsers}</div>
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div className="text-sm text-slate-500">可分配角色</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-950">{roles.length}</div>
                </div>
              </div>
            </div>
          </header>

          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Employee Accounts
                </div>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">新增员工账号</h2>
                <p className="mt-2 text-sm text-slate-500">
                  建议由管理员统一开通员工账号，再根据岗位分配不同角色。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateForm((prev) => !prev)}
                className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800"
              >
                <UserRoundPlus className="h-4 w-4" />
                {showCreateForm ? '收起创建表单' : '创建员工账号'}
              </button>
            </div>

            {showCreateForm && (
              <div className="mt-5 grid gap-4 rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.98))] p-5 shadow-sm lg:grid-cols-[1.2fr_0.8fr]">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">用户名</label>
                    <input
                      type="text"
                      value={createForm.username}
                      onChange={(e) => setCreateForm((prev) => ({ ...prev, username: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="例如：zhangsan"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">邮箱</label>
                    <input
                      type="email"
                      value={createForm.email}
                      onChange={(e) => setCreateForm((prev) => ({ ...prev, email: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="employee@company.com"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="mb-2 block text-sm font-semibold text-slate-700">初始密码</label>
                    <input
                      type="password"
                      value={createForm.password}
                      onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="不少于 6 位"
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-sm font-semibold text-slate-700">初始角色</div>
                  <div className="flex flex-wrap gap-2 rounded-[22px] border border-slate-200 bg-white p-4">
                    {roles.map((role) => (
                      <button
                        key={role.id}
                        type="button"
                        onClick={() => toggleRole(role.id, 'create')}
                        className={`rounded-full border px-3 py-2 text-sm font-medium transition ${
                          createForm.roleIds.includes(role.id)
                            ? 'border-sky-300 bg-sky-100 text-sky-700'
                            : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {role.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="lg:col-span-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Plus className="h-4 w-4" />
                    {submitting ? '创建中...' : '创建并分配角色'}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Directory
                </div>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">员工账号列表</h2>
              </div>
            </div>

            {error && (
              <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            {loading ? (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center text-slate-500">
                正在加载员工账号...
              </div>
            ) : (
              <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">员工</th>
                        <th className="px-4 py-3 text-left font-semibold">联系方式</th>
                        <th className="px-4 py-3 text-left font-semibold">状态</th>
                        <th className="px-4 py-3 text-left font-semibold">角色</th>
                        <th className="px-4 py-3 text-right font-semibold">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {users.map((user) => (
                        <tr key={user.id} className="hover:bg-slate-50/80">
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                                <UserRound className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="font-semibold text-slate-900">{user.username}</div>
                                <div className="text-xs text-slate-400">ID #{user.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-slate-600">
                            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium">
                              <Mail className="h-3.5 w-3.5 text-sky-600" />
                              {user.email || '未设置邮箱'}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span
                              className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                                user.status === 1
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-rose-100 text-rose-700'
                              }`}
                            >
                              {user.status === 1 ? '启用' : '禁用'}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-wrap gap-2">
                              {user.roles.length > 0 ? (
                                user.roles.map((role) => (
                                  <span
                                    key={role.id}
                                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600"
                                  >
                                    {role.name}
                                  </span>
                                ))
                              ) : (
                                <span className="text-xs text-slate-400">未分配角色</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleEdit(user)}
                                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                              >
                                <PencilLine className="h-3.5 w-3.5" />
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(user.id)}
                                disabled={submitting || user.id === currentUser?.id}
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

          {editingUser && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm">
              <div className="w-full max-w-2xl rounded-[28px] border border-white/70 bg-white p-6 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.75)] md:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                      Edit Employee
                    </div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                      编辑账号：{editingUser.username}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingUser(null)}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    关闭
                  </button>
                </div>

                <div className="grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">邮箱</label>
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    />

                    <label className="mt-5 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={editForm.isActive}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                        className="rounded"
                      />
                      允许该员工账号正常登录和使用系统
                    </label>
                  </div>

                  <div>
                    <div className="mb-2 text-sm font-semibold text-slate-700">角色分配</div>
                    <div className="flex flex-wrap gap-2 rounded-[22px] border border-slate-200 bg-slate-50 p-4">
                      {roles.map((role) => (
                        <button
                          key={role.id}
                          type="button"
                          onClick={() => toggleRole(role.id, 'edit')}
                          className={`rounded-full border px-3 py-2 text-sm font-medium transition ${
                            selectedRoles.includes(role.id)
                              ? 'border-sky-300 bg-sky-100 text-sky-700'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {role.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-8 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingUser(null)}
                    className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={submitting}
                    className="rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? '保存中...' : '保存账号设置'}
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
