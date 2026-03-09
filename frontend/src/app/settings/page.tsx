'use client'

import { useState, useEffect } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { fetchCurrentUser, getStoredUser } from '@/lib/auth'
import type { AuthUser } from '@/types'

export default function SettingsPage() {
  const [profile, setProfile] = useState<AuthUser | null>(getStoredUser())
  const [loading, setLoading] = useState(true)

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
                <p className="text-sm text-gray-400">更多设置功能即将推出...</p>
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
