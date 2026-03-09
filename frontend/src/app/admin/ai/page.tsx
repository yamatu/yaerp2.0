'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, Save, ArrowLeft, CheckCircle2, XCircle } from 'lucide-react'
import api from '@/lib/api'
import { AuthGuard } from '@/components/auth/AuthGuard'

export default function AdminAIPage() {
  const router = useRouter()
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [configured, setConfigured] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await api.get('/admin/ai/config')
        const data = res.data as { endpoint?: string; model?: string }
        setEndpoint(data.endpoint || '')
        setModel(data.model || '')
        setConfigured(!!(data.endpoint && data.model))
      } catch {
        setConfigured(false)
      } finally {
        setLoading(false)
      }
    }
    loadConfig()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put('/admin/ai/config', { endpoint, api_key: apiKey, model })
      setConfigured(!!(endpoint && model))
      setApiKey('')
    } catch {
      // save failed
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-2xl mx-auto">
          {/* Back Button */}
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 text-slate-500 hover:text-slate-700 transition mb-6 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            返回首页
          </button>

          {/* Main Card */}
          <div className="bg-white rounded-[28px] border border-slate-200 p-8">
            {/* Header */}
            <div className="flex items-center gap-3 mb-8">
              <div className="bg-slate-900 text-white p-3 rounded-2xl">
                <Bot className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-slate-900">
                  AI 助手配置
                </h1>
                <p className="text-sm text-slate-500 mt-0.5">
                  配置 AI 助手的连接参数
                </p>
              </div>
            </div>

            {/* Status */}
            <div className="mb-8">
              {loading ? (
                <div className="text-sm text-slate-400">加载中...</div>
              ) : configured ? (
                <div className="flex items-center gap-2 text-emerald-600 bg-emerald-50 px-4 py-2.5 rounded-xl text-sm">
                  <CheckCircle2 className="w-4 h-4" />
                  AI 助手已配置
                </div>
              ) : (
                <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-2.5 rounded-xl text-sm">
                  <XCircle className="w-4 h-4" />
                  AI 助手未配置
                </div>
              )}
            </div>

            {/* Form */}
            <div className="space-y-5">
              {/* API Endpoint */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  API 端点
                </label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300"
                />
              </div>

              {/* API Key */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  API 密钥
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300"
                />
                <p className="text-xs text-slate-400 mt-1">
                  密钥不会回显，留空表示不修改
                </p>
              </div>

              {/* Model Name */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  模型名称
                </label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o"
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300"
                />
              </div>
            </div>

            {/* Save Button */}
            <div className="mt-8">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-slate-900 text-white px-6 py-2.5 rounded-xl hover:bg-slate-800 transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
