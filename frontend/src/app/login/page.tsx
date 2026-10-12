'use client'

import { Building2, Eye, EyeOff, Loader2, LockKeyhole, LogIn, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
  const usernameRef = useRef<HTMLInputElement | null>(null)
  const passwordRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/')
      return
    }
    const remembered = localStorage.getItem(REMEMBERED_USERNAME_KEY)
    if (remembered) setUsername(remembered)
    // Desktop: focus straight away. Phones: wait for a tap so the keyboard does
    // not cover the brand header the moment the app opens.
    if (window.matchMedia('(min-width: 768px)').matches) {
      window.setTimeout(() => (remembered ? passwordRef.current : usernameRef.current)?.focus(), 0)
    }
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
    <div className="flex min-h-[100dvh] flex-col bg-slate-900 md:bg-slate-100">
      <header className="hidden border-b border-slate-200 bg-white md:block">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-semibold text-slate-950">YaERP 2.0</div>
              <div className="text-xs text-slate-400">企业资源协同工作台</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            企业内部系统
          </div>
        </div>
      </header>

      {/* Phone brand hero: the form sheet slides up underneath it. */}
      <div className="relative overflow-hidden px-6 pb-10 pt-[calc(env(safe-area-inset-top)+3rem)] text-white md:hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_88%_8%,rgba(56,189,248,0.38),transparent_52%),radial-gradient(circle_at_0%_85%,rgba(99,102,241,0.22),transparent_45%)]" />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20">
          <Building2 className="h-7 w-7" />
        </div>
        <h1 className="relative mt-5 text-3xl font-semibold tracking-tight">YaERP</h1>
        <p className="relative mt-1.5 text-sm text-slate-300">企业资源协同工作台</p>
      </div>

      <main className="flex flex-1 flex-col md:items-center md:justify-center md:px-6 md:py-8">
        <div className="flex w-full flex-1 flex-col overflow-hidden rounded-t-[28px] bg-white md:max-w-md md:flex-none md:rounded-lg md:border md:border-slate-200 md:shadow-xl md:shadow-slate-300/30">
          <div className="hidden border-b border-slate-200 px-7 py-6 md:block">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-2xl font-semibold text-slate-950">登录工作台</h2>
            <p className="mt-1.5 text-sm text-slate-500">请使用管理员分配的员工账号登录</p>
          </div>
          <div className="px-6 pt-7 md:hidden">
            <h2 className="text-xl font-semibold text-slate-950">欢迎回来</h2>
            <p className="mt-1 text-sm text-slate-500">使用管理员分配的员工账号登录</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5 px-6 py-6 md:px-7">
            {error && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                {error}
              </div>
            )}

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-700">用户名</span>
              <div className="flex h-12 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 focus-within:border-sky-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-sky-100 md:h-11 md:rounded-lg md:bg-white">
                <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  ref={usernameRef}
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !password) {
                      event.preventDefault()
                      passwordRef.current?.focus()
                    }
                  }}
                  placeholder="请输入用户名"
                  className="min-w-0 flex-1 bg-transparent text-base text-slate-800 outline-none placeholder:text-slate-400 md:text-sm"
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-700">密码</span>
              <div className="flex h-12 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 focus-within:border-sky-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-sky-100 md:h-11 md:rounded-lg md:bg-white">
                <LockKeyhole className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  enterKeyHint="go"
                  placeholder="请输入密码"
                  className="min-w-0 flex-1 bg-transparent text-base text-slate-800 outline-none placeholder:text-slate-400 md:text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  className="-mr-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 md:h-8 md:w-8"
                  title={showPassword ? '隐藏密码' : '显示密码'}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={rememberUsername} onChange={(event) => setRememberUsername(event.target.checked)} className="h-5 w-5 rounded border-slate-300 text-sky-600 focus:ring-sky-500 md:h-4 md:w-4" />
              记住用户名
            </label>

            <button type="submit" disabled={loading || !username.trim() || !password} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-base font-semibold text-white transition hover:bg-slate-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 md:h-11 md:rounded-lg md:text-sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {loading ? '正在登录...' : '登录'}
            </button>
          </form>

          <div className="mt-auto border-t border-slate-100 bg-slate-50 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-xs text-slate-400 md:mt-0 md:px-7 md:pb-3">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 md:hidden" />
              账号开通、权限调整或密码重置请联系系统管理员
            </span>
          </div>
        </div>
      </main>

      <footer className="hidden px-4 pb-6 text-center text-xs text-slate-400 md:block">
        YaERP 企业资源协同系统
      </footer>
    </div>
  )
}
