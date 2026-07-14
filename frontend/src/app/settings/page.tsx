'use client'

import { Camera, ChevronLeft, KeyRound, UserRound } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import { fetchCurrentUser, getStoredUser, saveCurrentUser } from '@/lib/auth'
import type { AuthUser } from '@/types'

export default function SettingsPage() {
  const [profile, setProfile] = useState<AuthUser | null>(getStoredUser())
  const [loading, setLoading] = useState(true)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

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

  const handleAvatarUpload = async (file: File | null) => {
    if (!file || uploadingAvatar) return
    if (!file.type.startsWith('image/')) {
      setMessage({ type: 'error', text: '头像必须使用图片文件。' })
      return
    }
    setUploadingAvatar(true)
    setMessage(null)
    try {
      const uploadRes = await api.upload(file)
      if (uploadRes.code !== 0 || !uploadRes.data?.id) {
        setMessage({ type: 'error', text: uploadRes.message || '上传头像失败。' })
        return
      }
      const profileRes = await api.put<AuthUser>('/auth/avatar', { attachment_id: uploadRes.data.id })
      if (profileRes.code !== 0 || !profileRes.data) {
        setMessage({ type: 'error', text: profileRes.message || '保存头像失败。' })
        return
      }
      setProfile(profileRes.data)
      saveCurrentUser(profileRes.data)
      setMessage({ type: 'success', text: '头像已更新。' })
    } catch {
      setMessage({ type: 'error', text: '上传头像失败，请稍后再试。' })
    } finally {
      setUploadingAvatar(false)
      if (avatarInputRef.current) avatarInputRef.current.value = ''
    }
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100 p-3 sm:p-5">
        <header className="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5">
          <div className="flex items-center gap-3">
            <a href="/" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" title="返回首页"><ChevronLeft className="h-4 w-4" /></a>
            <div>
              <h1 className="text-xl font-semibold text-slate-950">个人设置</h1>
              <p className="mt-0.5 text-sm text-slate-500">管理头像、账号资料和登录密码</p>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl py-3">
          {loading ? (
            <div className="text-center py-12 text-gray-500">加载中...</div>
          ) : profile ? (
            <div className="space-y-6">
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
                <div className="mb-5 flex flex-col gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-center">
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-900 text-white">
                    {profile.avatar ? <img src={profile.avatar} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center"><UserRound className="h-8 w-8" /></div>}
                    <button type="button" onClick={() => avatarInputRef.current?.click()} disabled={uploadingAvatar} className="absolute inset-x-0 bottom-0 flex h-7 items-center justify-center gap-1 bg-slate-950/75 text-[11px] font-medium text-white hover:bg-slate-950 disabled:opacity-60"><Camera className="h-3.5 w-3.5" />{uploadingAvatar ? '上传中' : '更换'}</button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-lg font-semibold text-slate-900">{profile.username}</h2>
                    <p className="mt-1 truncate text-sm text-slate-500">{profile.email || '未设置邮箱'}</p>
                    <p className="mt-2 text-xs text-slate-400">建议使用清晰的方形图片，频道成员会看到此头像。</p>
                  </div>
                  <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleAvatarUpload(event.target.files?.[0] || null)} />
                </div>
                <h2 className="mb-4 text-sm font-semibold text-slate-800">账号信息</h2>
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

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
                <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900"><KeyRound className="h-5 w-5 text-sky-600" />登录密码</h2>
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
