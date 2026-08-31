'use client'

import { Building2, Eye, EyeOff, LockKeyhole, LogIn, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import { fetchCurrentUser, isAuthenticated, saveTokens } from '@/lib/auth'
import type { TokenResponse } from '@/types'

const REMEMBERED_USERNAME_KEY = 'yaerp:remembered-username'

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberUsername, setRememberUsername] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/')
      return
    }
    const remembered = localStorage.getItem(REMEMBERED_USERNAME_KEY)
    if (remembered) setUsername(remembered)
  }, [router])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await api.post<TokenResponse>('/auth/login', { username: username.trim(), password })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '用户名或密码错误')
        return
      }
      if (rememberUsername) localStorage.setItem(REMEMBERED_USERNAME_KEY, username.trim())
      else localStorage.removeItem(REMEMBERED_USERNAME_KEY)
      saveTokens(res.data)
      await fetchCurrentUser()
      router.push('/')
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-semibold text-slate-950">YaERP 2.0</div>
              <div className="text-xs text-slate-400">企业资源协同工作台</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            企业内部系统
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <div className="w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl shadow-slate-300/30">
          <div className="border-b border-slate-200 px-5 py-5 sm:px-7 sm:py-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <h1 className="mt-4 text-2xl font-semibold text-slate-950">登录工作台</h1>
            <p className="mt-1.5 text-sm text-slate-500">请使用管理员分配的员工账号登录</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5 px-5 py-6 sm:px-7">
            {error && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                {error}
              </div>
            )}

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-700">用户名</span>
              <div className="flex h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100">
                <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  autoFocus
                  autoComplete="username"
                  placeholder="请输入用户名"
                  className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-700">密码</span>
              <div className="flex h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100">
                <LockKeyhole className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                />
                <button type="button" onClick={() => setShowPassword((current) => !current)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={showPassword ? '隐藏密码' : '显示密码'}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={rememberUsername} onChange={(event) => setRememberUsername(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500" />
              记住用户名
            </label>

            <button type="submit" disabled={loading || !username.trim() || !password} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
              <LogIn className="h-4 w-4" />
              {loading ? '正在登录...' : '登录'}
            </button>
          </form>

          <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-center text-xs text-slate-400 sm:px-7">
            账号开通、权限调整或密码重置请联系系统管理员
          </div>
        </div>
      </main>

      <footer className="px-4 pb-6 text-center text-xs text-slate-400">
        YaERP 企业资源协同系统
      </footer>
    </div>
  )
}
