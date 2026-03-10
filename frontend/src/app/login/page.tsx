'use client'

import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import { fetchCurrentUser, isAuthenticated, saveTokens } from '@/lib/auth'
import type { TokenResponse } from '@/types'

const highlights = [
  {
    title: '统一工作簿入口',
    description: '销售、库存、人事都以工作簿形式组织，降低培训成本。',
    icon: Sparkles,
  },
  {
    title: '细粒度权限',
    description: '管理员可控制员工账号、角色和字段级访问范围。',
    icon: ShieldCheck,
  },
  {
    title: '协作式编辑',
    description: '自动保存与实时同步让团队更像在共享表格中工作。',
    icon: Users,
  },
]

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/')
    }
  }, [router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await api.post<TokenResponse>('/auth/login', { username, password })
      if (res.code === 0 && res.data) {
        saveTokens(res.data)
        await fetchCurrentUser()
        router.push('/')
      } else {
        setError(res.message || '登录失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.18),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(251,191,36,0.16),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)] px-4 py-8 md:px-6">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl overflow-hidden rounded-[36px] border border-white/70 bg-white/80 shadow-[0_28px_100px_-56px_rgba(15,23,42,0.75)] backdrop-blur lg:grid-cols-[1.1fr_0.9fr]">
        <section className="relative overflow-hidden border-b border-slate-200/80 px-6 py-8 md:px-10 lg:border-b-0 lg:border-r">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.12),_transparent_36%),radial-gradient(circle_at_bottom_right,_rgba(250,204,21,0.14),_transparent_30%)]" />
          <div className="relative flex h-full flex-col justify-between gap-8">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
                <Sparkles className="h-3.5 w-3.5" />
                YaERP 2.0
              </div>
              <div className="space-y-4">
                <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-slate-950 md:text-5xl">
                  企业表格工作台，从登录开始就保持专业一致的体验。
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-slate-600 md:text-base">
                  当前登录页与首页、工作簿编辑页统一成同一套工作台语言，后续我会继续按计划文档逐步把整套 UI 往 ERP 化方向推进。
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {highlights.map((item) => {
                const Icon = item.icon

                return (
                  <div
                    key={item.title}
                    className="rounded-[24px] border border-slate-200 bg-white/90 p-5 shadow-sm"
                  >
                    <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="text-lg font-semibold text-slate-950">{item.title}</div>
                    <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center px-6 py-8 md:px-10">
          <div className="w-full max-w-lg space-y-6">
            <div className="rounded-[28px] border border-slate-200 bg-white/95 p-6 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.5)] md:p-8">
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-slate-600">
                    <LockKeyhole className="h-3.5 w-3.5" />
                    Secure Login
                  </div>
                  <h2 className="mt-4 text-3xl font-semibold text-slate-950">登录到工作台</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    员工账号建议由管理员在后台统一创建和维护，登录页默认仅保留登录入口。
                  </p>
                </div>
              </div>

              {error && (
                <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">用户名</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    placeholder="请输入管理员或员工用户名"
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">密码</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="请输入密码"
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-slate-900 px-5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? '正在登录...' : '进入 YaERP 工作台'}
                  {!loading && <ArrowRight className="h-4 w-4" />}
                </button>
              </form>
            </div>

            <div className="rounded-[24px] border border-slate-200 bg-white/80 p-5 text-sm leading-7 text-slate-500 shadow-sm">
              如需新增或重置员工账号，请联系系统管理员在后台统一创建与分配权限。
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
