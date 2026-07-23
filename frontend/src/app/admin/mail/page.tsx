"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import api from "@/lib/api";

interface MailServerSettings {
  enabled: boolean;
  imap_host: string;
  imap_port: number;
  imap_security: "tls" | "starttls";
  smtp_host: string;
  smtp_port: number;
  smtp_security: "tls" | "starttls";
  default_domain: string;
  allow_insecure_tls: boolean;
  max_attachment_mb: number;
  proxy_type: "none" | "socks5";
  proxy_host: string;
  proxy_port: number;
  proxy_username: string;
  proxy_password?: string;
  proxy_password_configured: boolean;
  configured: boolean;
  updated_at?: string;
}

interface MailAccount {
  id: number;
  user_id: number;
  username: string;
  user_email: string;
  email_address: string;
  display_name: string;
  enabled: boolean;
  password_configured: boolean;
  last_verified_at?: string;
  last_sync_at?: string;
  last_error?: string;
  auto_forward_enabled: boolean;
  auto_forward_to: string[];
}

const defaults: MailServerSettings = {
  enabled: false,
  imap_host: "",
  imap_port: 993,
  imap_security: "tls",
  smtp_host: "",
  smtp_port: 465,
  smtp_security: "tls",
  default_domain: "",
  allow_insecure_tls: false,
  max_attachment_mb: 25,
  proxy_type: "none",
  proxy_host: "",
  proxy_port: 1080,
  proxy_username: "",
  proxy_password: "",
  proxy_password_configured: false,
  configured: false,
};

function formatDate(value?: string) {
  if (!value) return "尚未连接";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function AdminMailPage() {
  const [settings, setSettings] = useState<MailServerSettings>(defaults);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [settingsRes, accountsRes] = await Promise.all([
        api.get<MailServerSettings>("/admin/mail/settings"),
        api.get<MailAccount[]>("/admin/mail/accounts"),
      ]);
      if (settingsRes.code !== 0 || !settingsRes.data)
        throw new Error(settingsRes.message || "无法读取邮件配置");
      setSettings(settingsRes.data);
      setAccounts(
        accountsRes.code === 0 && accountsRes.data ? accountsRes.data : [],
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法读取邮件配置",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const res = await api.put<MailServerSettings>(
        "/admin/mail/settings",
        settings,
      );
      if (res.code !== 0 || !res.data)
        throw new Error(res.message || "保存失败");
      setSettings(res.data);
      setNotice("邮件服务器配置已保存。员工现在可以绑定各自的 poste.io 邮箱。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const applyPosteDefaults = () => {
    const domain = settings.default_domain.trim();
    const host = domain
      ? `mail.${domain.replace(/^mail\./, "")}`
      : settings.imap_host || settings.smtp_host;
    setSettings((current) => ({
      ...current,
      imap_host: host,
      imap_port: 993,
      imap_security: "tls",
      smtp_host: host,
      smtp_port: 465,
      smtp_security: "tls",
    }));
  };

  return (
    <AdminShell
      title="邮件服务"
      description="配置 poste.io IMAP / SMTP，并查看员工邮箱绑定状态"
    >
      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-900">Poste.io 连接</h2>
              <p className="mt-1 text-sm text-slate-500">
                系统使用标准 IMAP 收件、SMTP
                发件。员工使用完整邮箱地址和自己的邮箱密码登录。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            title="刷新配置与账号状态"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4 sm:p-5">
          <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3 sm:col-span-2 lg:col-span-4">
            <div>
              <div className="text-sm font-semibold text-slate-800">
                启用邮件客户端
              </div>
              <div className="mt-1 text-xs text-slate-500">
                关闭后保留配置和员工绑定，但暂停收发邮件。
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
              className="h-4 w-4 accent-sky-600"
            />
          </label>

          <label className="sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              邮箱域名
            </span>
            <input
              value={settings.default_domain}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  default_domain: event.target.value,
                }))
              }
              placeholder="example.com"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
            />
          </label>
          <div className="flex items-end sm:col-span-2">
            <button
              type="button"
              onClick={applyPosteDefaults}
              className="h-10 w-full rounded-lg border border-sky-200 bg-sky-50 px-3 text-sm font-medium text-sky-700 hover:bg-sky-100"
            >
              按 poste.io 推荐端口填充
            </button>
          </div>

          <label className="sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              IMAP 主机
            </span>
            <input
              value={settings.imap_host}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  imap_host: event.target.value,
                }))
              }
              placeholder="mail.example.com"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              IMAP 端口
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              value={settings.imap_port}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  imap_port: Number(event.target.value),
                }))
              }
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              IMAP 加密
            </span>
            <select
              value={settings.imap_security}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  imap_security: event.target
                    .value as MailServerSettings["imap_security"],
                }))
              }
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
            >
              <option value="tls">TLS / SSL</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>

          <label className="sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              SMTP 主机
            </span>
            <input
              value={settings.smtp_host}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  smtp_host: event.target.value,
                }))
              }
              placeholder="mail.example.com"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              SMTP 端口
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              value={settings.smtp_port}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  smtp_port: Number(event.target.value),
                }))
              }
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              SMTP 加密
            </span>
            <select
              value={settings.smtp_security}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  smtp_security: event.target
                    .value as MailServerSettings["smtp_security"],
                }))
              }
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
            >
              <option value="tls">TLS / SSL</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>

          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              单封附件上限 / MB
            </span>
            <input
              type="number"
              min={1}
              max={50}
              value={settings.max_attachment_mb}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  max_attachment_mb: Number(event.target.value),
                }))
              }
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"
            />
          </label>
          <label className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:col-span-1 lg:col-span-3">
            <input
              type="checkbox"
              checked={settings.allow_insecure_tls}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  allow_insecure_tls: event.target.checked,
                }))
              }
              className="h-4 w-4 accent-amber-600"
            />
            <div>
              <div className="text-sm font-medium text-amber-900">
                允许不受信任的 TLS 证书
              </div>
              <div className="mt-0.5 text-xs text-amber-700">
                仅内网自签名证书使用；生产环境建议关闭。
              </div>
            </div>
          </label>

          <div className="border-t border-slate-200 pt-4 sm:col-span-2 lg:col-span-4">
            <div className="text-sm font-semibold text-slate-800">
              邮件网络代理
            </div>
            <div className="mt-1 text-xs text-slate-500">
              IMAP 和 SMTP 会统一通过该 SOCKS5 代理连接；员工无需单独配置。
            </div>
          </div>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              代理方式
            </span>
            <select
              value={settings.proxy_type}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  proxy_type: event.target
                    .value as MailServerSettings["proxy_type"],
                }))
              }
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
            >
              <option value="none">不使用代理</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              代理主机
            </span>
            <input
              disabled={settings.proxy_type === "none"}
              value={settings.proxy_host}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  proxy_host: event.target.value,
                }))
              }
              placeholder="127.0.0.1"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              代理端口
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              disabled={settings.proxy_type === "none"}
              value={settings.proxy_port || ""}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  proxy_port: Number(event.target.value || 0),
                }))
              }
              placeholder="1080"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50"
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              代理账号
            </span>
            <input
              disabled={settings.proxy_type === "none"}
              value={settings.proxy_username}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  proxy_username: event.target.value,
                }))
              }
              placeholder="可留空"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50"
            />
          </label>
          <label className="sm:col-span-2 lg:col-span-4">
            <span className="mb-1.5 block text-xs font-medium text-slate-600">
              代理密码
            </span>
            <input
              type="password"
              disabled={settings.proxy_type === "none"}
              value={settings.proxy_password || ""}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  proxy_password: event.target.value,
                }))
              }
              placeholder={
                settings.proxy_password_configured
                  ? "已保存，留空不修改"
                  : "无密码可留空"
              }
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50"
            />
          </label>
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="text-xs text-slate-500">
            Poste.io 推荐：IMAP 993 TLS；SMTP 465 TLS，或 SMTP 587 STARTTLS。
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
        {error && (
          <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 sm:mx-5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {notice && (
          <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 sm:mx-5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {notice}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-900">员工邮箱绑定</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              管理员只能查看连接状态，不能查看员工邮箱密码和邮件正文。
            </p>
          </div>
        </div>
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            正在加载
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-sm text-slate-400">
            <Mail className="mb-2 h-7 w-7 text-slate-300" />
            尚无员工绑定邮箱
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900">
                    {account.username}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-400">
                    系统账号 #{account.user_id}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-700">
                    {account.email_address}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-400">
                    {account.display_name || "未设置发件人名称"}
                  </div>
                  {account.auto_forward_enabled && (
                    <div className="mt-1 truncate text-[11px] text-sky-600">
                      自动转发至 {account.auto_forward_to.join("、")}
                    </div>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  <div>验证：{formatDate(account.last_verified_at)}</div>
                  <div className="mt-1">
                    同步：{formatDate(account.last_sync_at)}
                  </div>
                </div>
                <div
                  className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${account.enabled && !account.last_error ? "bg-emerald-50 text-emerald-700" : account.last_error ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500"}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${account.enabled && !account.last_error ? "bg-emerald-500" : account.last_error ? "bg-rose-500" : "bg-slate-400"}`}
                  />
                  {account.last_error
                    ? "连接异常"
                    : account.enabled
                      ? "已启用"
                      : "已停用"}
                </div>
                {account.last_error && (
                  <div className="sm:col-start-2 sm:col-span-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {account.last_error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </AdminShell>
  );
}
