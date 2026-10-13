"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, MessageCircle, Search, X } from "lucide-react";
import { WhatsAppAvatarImage } from "@/components/whatsapp/WhatsAppAvatarImage";
import { matchesWhatsAppChat } from "@/lib/whatsappSearch";
import type { TradeCustomer, WhatsAppAccount, WhatsAppChat } from "@/types";

export interface CustomerDraft {
  name: string;
  company_name: string;
  country: string;
  region: string;
  contact_name: string;
  email: string;
  phone: string;
  source: TradeCustomer["source"];
  status: TradeCustomer["status"];
  customer_level: TradeCustomer["customer_level"];
  tags: string;
  notes: string;
  whatsapp_account_id?: number;
  whatsapp_chat_id: string;
  whatsapp_chat_name: string;
  avatar_url: string;
}

function draftFor(customer: TradeCustomer | null): CustomerDraft {
  if (!customer) {
    return {
      name: "",
      company_name: "",
      country: "",
      region: "",
      contact_name: "",
      email: "",
      phone: "",
      source: "manual",
      status: "lead",
      customer_level: "B",
      tags: "",
      notes: "",
      whatsapp_chat_id: "",
      whatsapp_chat_name: "",
      avatar_url: "",
    };
  }
  return {
    name: customer.name,
    company_name: customer.company_name,
    country: customer.country,
    region: customer.region,
    contact_name: customer.contact_name,
    email: customer.email,
    phone: customer.phone,
    source: customer.source,
    status: customer.status,
    customer_level: customer.customer_level,
    tags: (customer.tags || []).join(", "),
    notes: customer.notes,
    whatsapp_account_id: customer.whatsapp_account_id,
    whatsapp_chat_id: customer.whatsapp_chat_id,
    whatsapp_chat_name: customer.whatsapp_chat_name,
    avatar_url: customer.avatar_url,
  };
}

interface Props {
  editingCustomer: TradeCustomer | null;
  initialMode: "manual" | "whatsapp";
  saving: boolean;
  sourceLabels: Record<TradeCustomer["source"], string>;
  statusLabels: Record<TradeCustomer["status"], string>;
  whatsAppAccount: WhatsAppAccount | null;
  whatsAppChats: WhatsAppChat[];
  whatsAppLoading: boolean;
  onLoadWhatsApp: () => void;
  onClose: () => void;
  onSubmit: (draft: CustomerDraft) => void;
}

const INPUT_CLASS =
  "mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none";

/**
 * Owns the draft itself: typing must only re-render this dialog, not the whole
 * trade page that hosts it.
 */
export function CustomerFormModal({
  editingCustomer,
  initialMode,
  saving,
  sourceLabels,
  statusLabels,
  whatsAppAccount,
  whatsAppChats,
  whatsAppLoading,
  onLoadWhatsApp,
  onClose,
  onSubmit,
}: Props) {
  const [draft, setDraft] = useState<CustomerDraft>(() =>
    draftFor(editingCustomer),
  );
  const [mode, setMode] = useState(editingCustomer ? "manual" : initialMode);
  const [chatSearch, setChatSearch] = useState("");
  const set = <K extends keyof CustomerDraft>(key: K, value: CustomerDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const chatCount = whatsAppChats.length;
  useEffect(() => {
    if (!editingCustomer && mode === "whatsapp" && chatCount === 0)
      onLoadWhatsApp();
  }, [chatCount, editingCustomer, mode, onLoadWhatsApp]);

  const filteredChats = useMemo(
    () => whatsAppChats.filter((chat) => matchesWhatsAppChat(chat, chatSearch)),
    [whatsAppChats, chatSearch],
  );

  const chooseChat = (chat: WhatsAppChat) => {
    const phone = chat.id.split("@")[0].replace(/\D/g, "");
    setDraft((current) => ({
      ...current,
      name: chat.name || phone,
      company_name: chat.name || "",
      contact_name: chat.name || "",
      phone,
      source: "whatsapp",
      whatsapp_account_id: whatsAppAccount?.id,
      whatsapp_chat_id: chat.id,
      whatsapp_chat_name: chat.name,
      avatar_url: chat.profilePicUrl,
      notes: chat.about || chat.description || "",
    }));
  };

  const textField = (
    label: string,
    key: "name" | "company_name" | "contact_name" | "phone" | "email" | "country" | "region",
    required = false,
  ) => (
    <label className="text-sm font-medium text-slate-700">
      {label}
      {required && <span className="text-rose-500"> *</span>}
      <input
        value={draft[key]}
        onChange={(event) => set(key, event.target.value)}
        className={INPUT_CLASS}
      />
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-[62] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">
              {editingCustomer ? "编辑客户资料" : "录入客户"}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {editingCustomer
                ? `${editingCustomer.customer_code} · 姓名、联系人和备注都可以修改或清空。`
                : "填写后保存即可建档，之后可随时在客户页签中修改。"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!editingCustomer && (
            <div className="mb-4 flex border-b border-slate-200">
              <button
                type="button"
                onClick={() => setMode("manual")}
                className={`border-b-2 px-3 py-2 text-sm font-medium ${mode === "manual" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400"}`}
              >
                手工录入
              </button>
              <button
                type="button"
                onClick={() => setMode("whatsapp")}
                className={`border-b-2 px-3 py-2 text-sm font-medium ${mode === "whatsapp" ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-400"}`}
              >
                从 WhatsApp 录入
              </button>
            </div>
          )}
          {!editingCustomer && mode === "whatsapp" && (
            <div className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 p-3">
              {whatsAppLoading ? (
                <div className="flex h-32 items-center justify-center text-sm text-emerald-700">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在读取会话...
                </div>
              ) : whatsAppAccount?.status !== "ready" ? (
                <div className="py-5 text-center">
                  <MessageCircle className="mx-auto h-7 w-7 text-emerald-600" />
                  <div className="mt-2 text-sm font-semibold">
                    WhatsApp 尚未连接
                  </div>
                  <Link
                    href="/whatsapp"
                    className="mt-3 inline-flex h-8 items-center rounded-lg bg-emerald-700 px-3 text-xs font-semibold text-white"
                  >
                    前往绑定
                  </Link>
                </div>
              ) : (
                <>
                  <label className="flex h-9 items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 text-sm text-slate-500">
                    <Search className="h-4 w-4" />
                    <input
                      type="search"
                      value={chatSearch}
                      onChange={(event) => setChatSearch(event.target.value)}
                      placeholder="搜索客户姓名、号码或最近消息"
                      className="min-w-0 flex-1 outline-none"
                    />
                    <span className="text-[11px] text-slate-400">
                      {filteredChats.length}/{whatsAppChats.length}
                    </span>
                  </label>
                  <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-emerald-100 bg-white">
                    {filteredChats.map((chat) => {
                      const selected = draft.whatsapp_chat_id === chat.id;
                      return (
                        <button
                          key={chat.id}
                          type="button"
                          onClick={() => chooseChat(chat)}
                          className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 ${selected ? "bg-emerald-50" : "hover:bg-slate-50"}`}
                        >
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100">
                            <WhatsAppAvatarImage
                              src={chat.profilePicUrl}
                              fallback={
                                <MessageCircle className="h-4 w-4 text-slate-400" />
                              }
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">
                              {chat.name}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-slate-400">
                              {chat.lastMessage || chat.about || chat.id}
                            </div>
                          </div>
                          {selected && (
                            <Check className="h-4 w-4 text-emerald-600" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("客户简称", "name", true)}
            {textField("公司全称", "company_name")}
            {textField("联系人", "contact_name")}
            {textField("电话 / WhatsApp", "phone")}
            {textField("邮箱", "email")}
            {textField("国家/地区", "country")}
            {textField("州/省/地区", "region")}
            <label className="text-sm font-medium text-slate-700">
              客户来源
              <select
                value={draft.source}
                onChange={(event) =>
                  set("source", event.target.value as TradeCustomer["source"])
                }
                className={`${INPUT_CLASS} bg-white`}
              >
                {Object.entries(sourceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">
              客户等级
              <select
                value={draft.customer_level}
                onChange={(event) =>
                  set(
                    "customer_level",
                    event.target.value as TradeCustomer["customer_level"],
                  )
                }
                className={`${INPUT_CLASS} bg-white`}
              >
                <option value="A">A · 重点客户</option>
                <option value="B">B · 普通客户</option>
                <option value="C">C · 潜在客户</option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">
              客户状态
              <select
                value={draft.status}
                onChange={(event) =>
                  set("status", event.target.value as TradeCustomer["status"])
                }
                className={`${INPUT_CLASS} bg-white`}
              >
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
              标签
              <input
                value={draft.tags}
                onChange={(event) => set("tags", event.target.value)}
                className={INPUT_CLASS}
                placeholder="批发商, 欧洲, 重点跟进"
              />
            </label>
            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
              备注
              <textarea
                value={draft.notes}
                onChange={(event) => set("notes", event.target.value)}
                className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 outline-none"
              />
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSubmit(draft)}
            disabled={saving || !draft.name.trim()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editingCustomer ? "保存修改" : "保存客户"}
          </button>
        </div>
      </div>
    </div>
  );
}
