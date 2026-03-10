'use client'

import { useState, useEffect } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import { fetchCurrentUser, getStoredUser } from '@/lib/auth'
import type { AuthUser } from '@/types'

export default function SettingsPage() {
  const [profile, setProfile] = useState<AuthUser | null>(getStoredUser())
  const [loading, setLoading] = useState(true)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const user = await fetchCurrentUser()
        if (user) {
          setProfile(user)
        }
      } catch (err) {
        console.error('Failed to fetch profile:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchProfile()
  }, [])

  const handleChangePassword = async () => {
    setMessage(null)
    if (!currentPassword || !newPassword) {
      setMessage({ type: 'error', text: '请填写当前密码和新密码。' })
      return
    }
    if (newPassword.length < 6) {
      setMessage({ type: 'error', text: '新密码至少 6 位。' })
      return
    }
    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: '两次输入的新密码不一致。' })
      return
    }

    setSubmitting(true)
    try {
      const res = await api.post('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      })
      if (res.code !== 0) {
        setMessage({ type: 'error', text: res.message || '修改密码失败。' })
        return
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setMessage({ type: 'success', text: '密码修改成功。' })
    } catch (err) {
      console.error('Failed to change password:', err)
      setMessage({ type: 'error', text: '修改密码失败，请稍后再试。' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="max-w-3xl mx-auto flex items-center gap-3">
            <a href="/" className="text-gray-400 hover:text-gray-600">← 返回</a>
            <h1 className="text-xl font-bold text-gray-900">设置</h1>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 py-8">
          {loading ? (
            <div className="text-center py-12 text-gray-500">加载中...</div>
          ) : profile ? (
            <div className="space-y-6">
              {/* Profile Info */}
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">个人信息</h2>
                <div className="space-y-3">
                  <div className="flex items-center">
                    <span className="w-24 text-sm text-gray-500">用户名</span>
                    <span className="text-sm font-medium text-gray-900">{profile.username}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-24 text-sm text-gray-500">邮箱</span>
                    <span className="text-sm text-gray-900">{profile.email || '未设置'}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-24 text-sm text-gray-500">状态</span>
                    <span className={`text-sm px-2 py-0.5 rounded-full ${
                      profile.status === 1
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-700'
                    }`}>
                      {profile.status === 1 ? '活跃' : '禁用'}
                    </span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-24 text-sm text-gray-500">角色</span>
                    <span className="text-sm text-gray-900">
                      {profile.roles.map((r) => r.name).join(', ') || '无'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Placeholder sections */}
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">系统设置</h2>
                <div className="space-y-4">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-gray-700">当前密码</label>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-gray-700">新密码</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-gray-700">确认新密码</label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    />
                  </div>
                  {message && (
                    <div className={`rounded-xl px-4 py-3 text-sm font-medium ${message.type === 'success' ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-rose-200 bg-rose-50 text-rose-700'}`}>
                      {message.text}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={submitting}
                    className="inline-flex h-11 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? '提交中...' : '修改密码'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-red-500">无法加载用户信息</div>
          )}
        </main>
      </div>
    </AuthGuard>
  )
}
