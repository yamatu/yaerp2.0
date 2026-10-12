'use client'

import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Loader2,
  LogOut,
  Search,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { ADMIN_MODULES, BUSINESS_MODULES, type AppModule } from '@/components/nav/appModules'
import MyPermissionsCard from '@/components/settings/MyPermissionsCard'
import api from '@/lib/api'
import {
  clearTokens,
  fetchCurrentUser,
  getRefreshToken,
  getStoredUser,
  isAdmin,
  saveCurrentUser,
} from '@/lib/auth'
import type { AuthUser } from '@/types'

/** Same event GlobalQuickNav listens to. */
const OPEN_COMMAND_PALETTE_EVENT = 'yaerp:open-command-palette'

/** Modules already reachable from the phone tab bar. */
const TAB_BAR_MODULE_IDS = new Set(['workbench', 'trade', 'mail', 'channels', 'settings'])

/** Preferred order for the "more apps" grid. */
const APP_ORDER = ['tasks', 'gallery', 'whatsapp', 'admin-proxy', 'recycle-bin', 'ai-summaries']

const APP_TINTS: Record<string, string> = {
  tasks: 'bg-emerald-50 text-emerald-700',
  gallery: 'bg-violet-50 text-violet-700',
  whatsapp: 'bg-green-50 text-green-700',
  'admin-proxy': 'bg-indigo-50 text-indigo-700',
  'recycle-bin': 'bg-rose-50 text-rose-700',
  'ai-summaries': 'bg-amber-50 text-amber-700',
}

const APP_SHORT_LABELS: Record<string, string> = {
  tasks: '任务',
  'admin-proxy': '代理',
}

export default function SettingsPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<AuthUser | null>(getStoredUser())
  const [loading, setLoading] = useState(true)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const admin = isAdmin(profile)

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
    // Wide screens have room to show everything expanded.
    if (window.matchMedia('(min-width: 1024px)').matches) {
      setPasswordOpen(true)
      setPermissionsOpen(true)
    }
  }, [])

  const apps = useMemo(() => {
    const candidates: AppModule[] = [
      ...BUSINESS_MODULES.filter((module) => !TAB_BAR_MODULE_IDS.has(module.id)),
      ...(admin ? ADMIN_MODULES.filter((module) => module.id === 'admin-proxy') : []),
    ]
    return candidates.sort((left, right) => {
      const a = APP_ORDER.indexOf(left.id)
      const b = APP_ORDER.indexOf(right.id)
      return (a === -1 ? 99 : a) - (b === -1 ? 99 : b)
    })
  }, [admin])

  const adminModules = useMemo(
    () => (admin ? ADMIN_MODULES.filter((module) => module.id !== 'admin-proxy') : []),
    [admin],
  )

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

  const handleLogout = async () => {
    if (loggingOut || !window.confirm('确定退出当前账号？')) return
    setLoggingOut(true)
    try {
      await api.post('/auth/logout', { refresh_token: getRefreshToken() })
    } catch {
      // Clear local state even when the server is unreachable.
    } finally {
      clearTokens()
      router.replace('/login')
    }
  }

  const openSearch = () => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
  }

  const roleNames = profile?.roles?.map((role) => role.name).filter(Boolean) ?? []

  return (
    <AuthGuard>
      <div className="min-h-[calc(100dvh-var(--mobile-tabbar-offset))] bg-slate-100 md:min-h-screen">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur md:static md:bg-white">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-3 md:h-16 md:px-5">
            <Link
              href="/"
              className="hidden h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 md:inline-flex"
              title="返回首页"
              aria-label="返回首页"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold text-slate-950 md:text-xl">
                <span className="md:hidden">我的</span>
                <span className="hidden md:inline">个人中心</span>
              </h1>
              <p className="hidden text-sm text-slate-500 md:block">账号资料、常用应用、权限与登录密码</p>
            </div>
            <button
              type="button"
              onClick={openSearch}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:w-auto md:gap-2 md:border md:border-slate-200 md:px-3 md:text-sm"
              aria-label="搜索模块或工作簿"
            >
              <Search className="h-5 w-5 md:h-4 md:w-4" />
              <span className="hidden md:inline">搜索</span>
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-3 pb-8 pt-3 md:px-5 md:pt-5 lg:grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start lg:gap-5">
          {loading && !profile ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500 lg:col-span-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : !profile ? (
            <div className="py-16 text-center text-sm text-rose-500 lg:col-span-2">无法加载用户信息</div>
          ) : (
            <>
              <div className="space-y-3">
                <section className="overflow-hidden rounded-2xl bg-slate-900 p-4 text-white shadow-sm">
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={uploadingAvatar}
                      className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-white/10 ring-2 ring-white/20"
                      aria-label="更换头像"
                    >
                      {profile.avatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={profile.avatar} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <UserRound className="h-7 w-7" />
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 flex h-5 items-center justify-center bg-slate-950/70">
                        {uploadingAvatar ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
                      </span>
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lg font-semibold">{profile.username}</div>
                      <div className="mt-0.5 truncate text-sm text-slate-300">{profile.email || '未设置邮箱'}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {admin && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                            <ShieldCheck className="h-3 w-3" />
                            管理员
                          </span>
                        )}
                        {roleNames.filter((name) => !admin || !/管理员|admin/i.test(name)).map((name) => (
                          <span key={name} className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-200">
                            {name}
                          </span>
                        ))}
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${profile.status === 1 ? 'bg-emerald-400/20 text-emerald-200' : 'bg-rose-400/20 text-rose-200'}`}>
                          {profile.status === 1 ? '活跃' : '禁用'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => void handleAvatarUpload(event.target.files?.[0] || null)}
                  />
                </section>

                {message && (
                  <div
                    role="status"
                    className={`rounded-xl px-4 py-3 text-sm font-medium ${message.type === 'success' ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-rose-200 bg-rose-50 text-rose-700'}`}
                  >
                    {message.text}
                  </div>
                )}

                <Section title="更多应用">
                  <div className="grid grid-cols-4 gap-1 p-2 sm:grid-cols-6 lg:grid-cols-3">
                    {apps.map((module) => (
                      <AppTile key={module.id} module={module} />
                    ))}
                  </div>
                </Section>

                {adminModules.length > 0 && (
                  <Section title="管理后台">
                    {adminModules
                      .filter((module) => module.id === 'admin')
                      .map((module) => (
                        <LinkRow
                          key={module.id}
                          href={module.href}
                          icon={module.icon}
                          label={module.label}
                          description={module.description}
                          emphasis
                        />
                      ))}
                    <div className="grid grid-cols-4 gap-1 p-2 sm:grid-cols-6 lg:grid-cols-3">
                      {adminModules
                        .filter((module) => module.id !== 'admin')
                        .map((module) => (
                          <AppTile key={module.id} module={module} compact />
                        ))}
                    </div>
                  </Section>
                )}
              </div>

              <div className="mt-3 space-y-3 lg:mt-0">
                <Section title="账号">
                  <InfoRow label="用户名" value={profile.username} />
                  <InfoRow label="邮箱" value={profile.email || '未设置'} />
                  <InfoRow label="角色" value={roleNames.join('、') || '无'} />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={uploadingAvatar}
                    className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-slate-700 active:bg-slate-50 disabled:opacity-60"
                  >
                    <Camera className="h-5 w-5 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1">{uploadingAvatar ? '正在上传头像…' : '更换头像'}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                  </button>
                </Section>

                <Section>
                  <button
                    type="button"
                    onClick={() => setPasswordOpen((current) => !current)}
                    aria-expanded={passwordOpen}
                    className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-slate-700 active:bg-slate-50"
                  >
                    <KeyRound className="h-5 w-5 shrink-0 text-sky-600" />
                    <span className="min-w-0 flex-1 font-medium">修改登录密码</span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${passwordOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {passwordOpen && (
                    <form
                      className="space-y-3 border-t border-slate-100 px-4 pb-4 pt-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void handleChangePassword()
                      }}
                    >
                      <input type="text" autoComplete="username" value={profile.username} readOnly hidden />
                      <PasswordField label="当前密码" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
                      <PasswordField label="新密码" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
                      <PasswordField label="确认新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
                      <button
                        type="submit"
                        disabled={submitting}
                        className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                      >
                        {submitting ? '提交中...' : '修改密码'}
                      </button>
                    </form>
                  )}
                </Section>

                <Section>
                  <button
                    type="button"
                    onClick={() => setPermissionsOpen((current) => !current)}
                    aria-expanded={permissionsOpen}
                    className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-slate-700 active:bg-slate-50"
                  >
                    <ShieldCheck className="h-5 w-5 shrink-0 text-sky-600" />
                    <span className="min-w-0 flex-1 font-medium">我的权限</span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${permissionsOpen ? 'rotate-180' : ''}`} />
                  </button>
                </Section>
                {permissionsOpen && <MyPermissionsCard />}

                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  disabled={loggingOut}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-[15px] font-semibold text-rose-600 shadow-sm transition hover:bg-rose-50 disabled:opacity-60"
                >
                  {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                  {loggingOut ? '正在退出…' : '退出登录'}
                </button>
                <p className="pb-2 text-center text-[11px] text-slate-400">YaERP 2.0 · 企业资源协同系统</p>
              </div>
            </>
          )}
        </main>
      </div>
    </AuthGuard>
  )
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="px-1 pb-1.5 text-xs font-semibold text-slate-500">{title}</h2>}
      <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {children}
      </div>
    </section>
  )
}

function AppTile({ module, compact = false }: { module: AppModule; compact?: boolean }) {
  const Icon = module.icon
  return (
    <Link
      href={module.href}
      className="flex min-h-[76px] flex-col items-center justify-start gap-1.5 rounded-xl px-1 py-2 text-center transition hover:bg-slate-50 active:scale-95 active:bg-slate-100"
      title={module.description}
    >
      <span
        className={`flex shrink-0 items-center justify-center ${
          compact ? 'h-10 w-10 rounded-xl bg-slate-100 text-slate-600' : `h-11 w-11 rounded-2xl ${APP_TINTS[module.id] || 'bg-sky-50 text-sky-700'}`
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className={`line-clamp-2 w-full font-medium leading-tight text-slate-700 ${compact ? 'text-[11px]' : 'text-xs'}`}>
        {APP_SHORT_LABELS[module.id] || module.label}
      </span>
    </Link>
  )
}

function LinkRow({
  href,
  icon: Icon,
  label,
  description,
  emphasis = false,
}: {
  href: string
  icon: LucideIcon
  label: string
  description?: string
  emphasis?: boolean
}) {
  return (
    <Link href={href} className="flex min-h-14 items-center gap-3 px-4 py-2 transition hover:bg-slate-50 active:bg-slate-100">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${emphasis ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${emphasis ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{label}</span>
        {description && <span className="block truncate text-xs text-slate-400">{description}</span>}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
    </Link>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 text-[15px]">
      <span className="w-16 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-slate-900">{value}</span>
    </div>
  )
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
      />
    </label>
  )
}
