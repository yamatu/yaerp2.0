"use client";

import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowUpDown,
  BookUser,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eye,
  File,
  FileText,
  Folder,
  FolderPlus,
  Forward,
  Inbox,
  Languages,
  Loader2,
  ListFilter,
  Mail,
  MailOpen,
  Menu,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  ReplyAll,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Type,
  UserPlus,
  X,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/auth/AuthGuard";
import api from "@/lib/api";

interface MailAccount {
  id: number;
  user_id: number;
  username: string;
  email_address: string;
  display_name: string;
  login_username: string;
  password_configured: boolean;
  signature_html: string;
  enabled: boolean;
  auto_forward_enabled: boolean;
  auto_forward_to: string[];
  forward_attachments: boolean;
  last_verified_at?: string;
  last_sync_at?: string;
  last_error?: string;
}

interface MailAccountInput {
  email_address: string;
  display_name: string;
  login_username: string;
  password: string;
  signature_html: string;
  enabled: boolean;
  auto_forward_enabled: boolean;
  auto_forward_to: string[];
  forward_attachments: boolean;
}

interface MailSummary {
  configured: boolean;
  enabled: boolean;
  address?: string;
  unread: number;
  total: number;
  last_error?: string;
}
interface MailFolder {
  name: string;
  display_name: string;
  delimiter?: string;
  role: string;
  total: number;
  unread: number;
  selectable: boolean;
}
interface MailAddress {
  name?: string;
  address: string;
}
interface MailAttachment {
  part_id: string;
  filename: string;
  content_type: string;
  size: number;
  inline: boolean;
  content_id?: string;
}
interface MailMessageSummary {
  uid: number;
  folder: string;
  message_id?: string;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  date: string;
  size: number;
  read: boolean;
  starred: boolean;
  has_attachment: boolean;
}
interface MailMessagePage {
  folder: string;
  messages: MailMessageSummary[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
}
interface MailMessageDetail extends MailMessageSummary {
  cc: MailAddress[];
  bcc?: MailAddress[];
  reply_to: MailAddress[];
  sender_avatar?: string;
  text_body: string;
  html_body: string;
  in_reply_to?: string;
  references?: string[];
  attachments: MailAttachment[];
}

interface MailContact {
  id: number;
  user_id: number;
  trade_customer_id?: number;
  name: string;
  company: string;
  email: string;
  phone?: string;
  notes?: string;
  source: "saved" | "erp";
}

interface MailContactInput {
  trade_customer_id?: number;
  name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
}

interface AIAssistant {
  id: number;
  name: string;
  model: string;
  is_default: boolean;
}
interface AITranslationResult {
  assistant_id: number;
  assistant_name: string;
  model: string;
  content: string;
  segments?: Array<{
    source: string;
    translation: string;
  }>;
}

interface ComposeState {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  format: "text" | "html";
  inReplyTo: string;
  references: string[];
  priority: "normal" | "high" | "low";
  requestReadReceipt: boolean;
}

interface MessageContextMenu {
  x: number;
  y: number;
  message: MailMessageSummary;
}

type MailFilterMode = "all" | "unread" | "attachment" | "contacts";
type MailSortMode = "date" | "size";
type MailSortOrder = "asc" | "desc";
type ContactSourceFilter = "all" | "erp" | "saved";

const emptyAccountInput: MailAccountInput = {
  email_address: "",
  display_name: "",
  login_username: "",
  password: "",
  signature_html: "",
  enabled: true,
  auto_forward_enabled: false,
  auto_forward_to: [],
  forward_attachments: true,
};
const emptyContact: MailContactInput = {
  name: "",
  company: "",
  email: "",
  phone: "",
  notes: "",
};
const emptyCompose: ComposeState = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  textBody: "",
  htmlBody: "",
  format: "text",
  inReplyTo: "",
  references: [],
  priority: "normal",
  requestReadReceipt: false,
};

const translationLanguages = [
  ["zh-CN", "简体中文"],
  ["en", "英语"],
  ["es", "西班牙语"],
  ["it", "意大利语"],
  ["de", "德语"],
  ["fr", "法语"],
  ["pt", "葡萄牙语"],
  ["ja", "日语"],
  ["ko", "韩语"],
  ["ar", "阿拉伯语"],
];

function addressLabel(addresses: MailAddress[]) {
  if (!addresses?.length) return "未知发件人";
  return addresses.map((item) => item.name || item.address).join(", ");
}

function addressValues(addresses: MailAddress[]) {
  return addresses
    .map((item) =>
      item.name ? `${item.name} <${item.address}>` : item.address,
    )
    .join("; ");
}

function splitAddresses(value: string) {
  return value
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendAddress(value: string, contact: MailContact) {
  const formatted = contact.name
    ? `${contact.name} <${contact.email}>`
    : contact.email;
  const current = splitAddresses(value);
  if (
    current.some((item) =>
      item.toLowerCase().includes(contact.email.toLowerCase()),
    )
  )
    return value;
  return [...current, formatted].join("; ");
}

function messageKey(message: Pick<MailMessageSummary, "folder" | "uid">) {
  return `${message.folder}:${message.uid}`;
}

function contactKey(contact: MailContact) {
  return `${contact.source}:${contact.id}:${contact.email.toLowerCase()}`;
}

function formatDate(value: string, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (!full && date.toDateString() === now.toDateString())
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return date.toLocaleString(
    "zh-CN",
    full
      ? { hour12: false }
      : {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        },
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function folderIcon(role: string) {
  if (role === "inbox") return Inbox;
  if (role === "sent") return Send;
  if (role === "drafts") return FileText;
  if (role === "trash") return Trash2;
  if (role === "archive") return Archive;
  if (role === "junk") return AlertTriangle;
  if (role === "flagged") return Star;
  return Folder;
}

function escapeHTML(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHTML(value: string) {
  return `<div style="white-space:pre-wrap">${escapeHTML(value)}</div>`;
}

function htmlToText(value: string) {
  if (typeof document === "undefined") return value.replace(/<[^>]+>/g, " ");
  const element = document.createElement("div");
  element.innerHTML = value;
  return element.textContent || "";
}

function iframeDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{margin:0;padding:0;background:#fff;color:#1e293b;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{display:block;max-width:min(100%,420px)!important;max-height:420px!important;width:auto!important;height:auto!important;object-fit:contain;margin:8px 0}table{max-width:100%;border-collapse:collapse}pre{white-space:pre-wrap}a{color:#0369a1}.yaerp-translation-pair{margin:0 0 14px;padding:0 0 14px;border-bottom:1px solid #e2e8f0}.yaerp-translation-source{white-space:pre-wrap;color:#334155}.yaerp-translation-result{margin-top:5px;padding:7px 10px;border-left:3px solid #10b981;border-radius:0 6px 6px 0;background:#ecfdf5;color:#065f46;white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}

export default function MailPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const previousInboxUnreadRef = useRef<number | null>(null);
  const mailStatusPollingRef = useRef(false);
  const mailAudioContextRef = useRef<AudioContext | null>(null);
  const [account, setAccount] = useState<MailAccount | null | undefined>(
    undefined,
  );
  const [accountInput, setAccountInput] =
    useState<MailAccountInput>(emptyAccountInput);
  const [summary, setSummary] = useState<MailSummary | null>(null);
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [pageData, setPageData] = useState<MailMessagePage>({
    folder: "INBOX",
    messages: [],
    page: 1,
    page_size: 30,
    total: 0,
    has_more: false,
  });
  const [selected, setSelected] = useState<MailMessageDetail | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<MailFilterMode>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sortBy, setSortBy] = useState<MailSortMode>("date");
  const [sortOrder, setSortOrder] = useState<MailSortOrder>("desc");
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [composeView, setComposeView] = useState<"edit" | "preview">("edit");
  const [composeFiles, setComposeFiles] = useState<globalThis.File[]>([]);
  const [sending, setSending] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [testingAccount, setTestingAccount] = useState(false);
  const [runningForward, setRunningForward] = useState(false);
  const [contacts, setContacts] = useState<MailContact[]>([]);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contactSourceFilter, setContactSourceFilter] =
    useState<ContactSourceFilter>("all");
  const [selectedContactKeys, setSelectedContactKeys] = useState<Set<string>>(
    new Set(),
  );
  const [contactDraft, setContactDraft] =
    useState<MailContactInput>(emptyContact);
  const [editingContactID, setEditingContactID] = useState<number | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [correspondenceContact, setCorrespondenceContact] =
    useState<MailContact | null>(null);
  const [contextMenu, setContextMenu] = useState<MessageContextMenu | null>(
    null,
  );
  const [assistants, setAssistants] = useState<AIAssistant[]>([]);
  const [assistantID, setAssistantID] = useState(0);
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [translation, setTranslation] = useState<AITranslationResult | null>(
    null,
  );
  const [translating, setTranslating] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [mobilePane, setMobilePane] = useState<
    "folders" | "messages" | "detail"
  >("messages");

  const selectedFolderMeta = useMemo(
    () => folders.find((folder) => folder.name === selectedFolder),
    [folders, selectedFolder],
  );
  const filteredContacts = useMemo(() => {
    const query = contactQuery.trim().toLowerCase();
    return contacts
      .filter((contact) => {
        if (
          contactSourceFilter !== "all" &&
          contact.source !== contactSourceFilter
        )
          return false;
        if (!query) return true;
        return [
          contact.name,
          contact.company,
          contact.email,
          contact.phone || "",
        ].some((value) => value.toLowerCase().includes(query));
      })
      .sort((left, right) =>
        (left.name || left.email).localeCompare(right.name || right.email),
      );
  }, [contactQuery, contactSourceFilter, contacts]);
  const selectedContacts = useMemo(
    () =>
      contacts.filter((contact) =>
        selectedContactKeys.has(contactKey(contact)),
      ),
    [contacts, selectedContactKeys],
  );
  const allFilteredContactsSelected =
    filteredContacts.length > 0 &&
    filteredContacts.every((contact) =>
      selectedContactKeys.has(contactKey(contact)),
    );
  const contactCounts = useMemo(
    () => ({
      all: contacts.length,
      erp: contacts.filter((contact) => contact.source === "erp").length,
      saved: contacts.filter((contact) => contact.source === "saved").length,
    }),
    [contacts],
  );
  const selectedSavedContactCount = selectedContacts.filter(
    (contact) => contact.source === "saved" && contact.id > 0,
  ).length;
  const allVisibleSelected =
    pageData.messages.length > 0 &&
    pageData.messages.every((message) => selectedKeys.has(messageKey(message)));
  const composePreview = useMemo(() => {
    if (!compose) return "";
    const body =
      compose.format === "html"
        ? compose.htmlBody
        : textToHTML(compose.textBody);
    return `${body}${account?.signature_html ? `<br><br>${account.signature_html}` : ""}`;
  }, [account?.signature_html, compose]);
  const displayedMailHTML = useMemo(() => {
    if (translation?.segments?.length) {
      return translation.segments
        .map(
          (segment) =>
            `<section class="yaerp-translation-pair"><div class="yaerp-translation-source">${escapeHTML(segment.source)}</div><div class="yaerp-translation-result">${escapeHTML(segment.translation)}</div></section>`,
        )
        .join("");
    }
    if (selected?.html_body) return selected.html_body;
    return textToHTML(selected?.text_body || "（无正文）");
  }, [selected, translation]);

  const loadAccount = useCallback(async () => {
    setError("");
    try {
      const accountRes = await api.get<MailAccount | null>("/mail/account");
      if (accountRes.code !== 0)
        throw new Error(accountRes.message || "无法读取邮箱账号");
      const value = accountRes.data || null;
      setAccount(value);
      setSummary(
        value
          ? {
              configured: true,
              enabled: value.enabled,
              address: value.email_address,
              unread: 0,
              total: 0,
              last_error: value.last_error,
            }
          : null,
      );
      setAccountInput(
        value
          ? {
              email_address: value.email_address,
              display_name: value.display_name,
              login_username: value.login_username,
              password: "",
              signature_html: value.signature_html,
              enabled: value.enabled,
              auto_forward_enabled: value.auto_forward_enabled,
              auto_forward_to: value.auto_forward_to || [],
              forward_attachments: value.forward_attachments,
            }
          : emptyAccountInput,
      );
    } catch (loadError) {
      setAccount(null);
      setError(
        loadError instanceof Error ? loadError.message : "无法读取邮箱账号",
      );
    }
  }, []);

  const loadFolders = useCallback(async () => {
    if (!account) return;
    setLoadingFolders(true);
    try {
      const res = await api.get<MailFolder[]>("/mail/folders");
      if (res.code !== 0 || !res.data)
        throw new Error(res.message || "无法读取邮件文件夹");
      setFolders(res.data);
      const inbox = res.data.find((folder) => folder.role === "inbox");
      if (inbox) {
        setSummary((current) =>
          current
            ? { ...current, unread: inbox.unread, total: inbox.total }
            : current,
        );
      }
      if (
        !res.data.some(
          (folder) => folder.name === selectedFolder && folder.selectable,
        )
      ) {
        const inbox =
          res.data.find(
            (folder) => folder.role === "inbox" && folder.selectable,
          ) || res.data.find((folder) => folder.selectable);
        if (inbox) setSelectedFolder(inbox.name);
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法读取邮件文件夹",
      );
    } finally {
      setLoadingFolders(false);
    }
  }, [account, selectedFolder]);

  const loadContacts = useCallback(async () => {
    if (!account) return;
    const res = await api.get<MailContact[]>("/mail/contacts");
    if (res.code === 0 && res.data) setContacts(res.data);
  }, [account]);

  const loadAssistants = useCallback(async () => {
    const res = await api.get<AIAssistant[]>("/ai/assistants");
    if (res.code !== 0 || !res.data) return;
    setAssistants(res.data);
    const preferred = res.data.find((item) => item.is_default) || res.data[0];
    if (preferred) setAssistantID(preferred.id);
  }, []);

  const loadMessages = useCallback(async (silent = false) => {
    if (!account || !selectedFolder) return;
    if (!silent) setLoadingMessages(true);
    setError("");
    try {
      let endpoint = "";
      if (correspondenceContact) {
        const params = new URLSearchParams({
          email: correspondenceContact.email,
          page: String(page),
          page_size: "30",
        });
        endpoint = `/mail/correspondence?${params.toString()}`;
      } else {
        const params = new URLSearchParams({
          folder: selectedFolder,
          page: String(page),
          page_size: "30",
          filter: filterMode,
          sort_by: sortBy,
          sort_order: sortOrder,
        });
        if (searchQuery) params.set("query", searchQuery);
        if (startDate) params.set("start_date", startDate);
        if (endDate) params.set("end_date", endDate);
        endpoint = `/mail/messages?${params.toString()}`;
      }
      const res = await api.get<MailMessagePage>(endpoint);
      if (res.code !== 0 || !res.data)
        throw new Error(res.message || "无法读取邮件");
      setPageData(res.data);
      setSelectedKeys(new Set());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取邮件");
      setPageData((current) => ({
        ...current,
        messages: [],
        total: 0,
        has_more: false,
      }));
    } finally {
      if (!silent) setLoadingMessages(false);
    }
  }, [
    account,
    correspondenceContact,
    endDate,
    filterMode,
    page,
    searchQuery,
    selectedFolder,
    sortBy,
    sortOrder,
    startDate,
  ]);

  const playMailNotificationSound = useCallback(async () => {
    if (
      !account?.user_id ||
      localStorage.getItem(
        `yaerp:channels:${account.user_id}:sound-enabled`,
      ) === "false"
    )
      return;
    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) return;
    if (!mailAudioContextRef.current)
      mailAudioContextRef.current = new AudioContextClass();
    const context = mailAudioContextRef.current;
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        return;
      }
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.frequency.setValueAtTime(740, now);
    oscillator.frequency.setValueAtTime(980, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  }, [account?.user_id]);

  const pollMailSummary = useCallback(async () => {
    if (!account || mailStatusPollingRef.current) return;
    mailStatusPollingRef.current = true;
    try {
      const response = await api.get<MailSummary>("/mail/summary");
      if (response.code !== 0 || !response.data) return;
      const next = response.data;
      const previous = previousInboxUnreadRef.current;
      previousInboxUnreadRef.current = next.unread;
      setSummary((current) =>
        current &&
        current.configured === next.configured &&
        current.enabled === next.enabled &&
        current.address === next.address &&
        current.unread === next.unread &&
        current.total === next.total &&
        current.last_error === next.last_error
          ? current
          : next,
      );
      setFolders((current) => {
        let changed = false;
        const updated = current.map((folder) => {
          if (
            folder.role !== "inbox" ||
            (folder.unread === next.unread && folder.total === next.total)
          )
            return folder;
          changed = true;
          return { ...folder, unread: next.unread, total: next.total };
        });
        return changed ? updated : current;
      });
      if (previous !== null && next.unread > previous) {
        const added = next.unread - previous;
        setNotice(`收到 ${added} 封新邮件，收件箱已更新。`);
        void playMailNotificationSound();
        if (
          selectedFolderMeta?.role === "inbox" &&
          page === 1 &&
          !correspondenceContact
        ) {
          void loadMessages(true);
        }
      }
    } catch {
      // Polling failures should not interrupt the current mail view.
    } finally {
      mailStatusPollingRef.current = false;
    }
  }, [
    account,
    correspondenceContact,
    loadMessages,
    page,
    playMailNotificationSound,
    selectedFolder,
    selectedFolderMeta?.role,
  ]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);
  useEffect(() => {
    if (account)
      void Promise.all([loadFolders(), loadContacts(), loadAssistants()]);
  }, [account, loadAssistants, loadContacts, loadFolders]);
  useEffect(() => {
    if (account) void loadMessages();
  }, [account, loadMessages]);
  useEffect(() => {
    if (!account) return;
    void pollMailSummary();
    const timer = window.setInterval(() => void pollMailSummary(), 12000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void pollMailSummary();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [account, pollMailSummary]);
  useEffect(() => {
    setPage(1);
  }, [endDate, filterMode, sortBy, sortOrder, startDate]);
  useEffect(() => {
    const close = (event: globalThis.MouseEvent) => {
      setContextMenu(null);
      if (
        filterMenuRef.current &&
        event.target instanceof Node &&
        !filterMenuRef.current.contains(event.target)
      ) {
        setFilterMenuOpen(false);
      }
    };
    window.addEventListener("click", close);
    const closeOnScroll = () => {
      setContextMenu(null);
      setFilterMenuOpen(false);
    };
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, []);
  useEffect(
    () => () => {
      const context = mailAudioContextRef.current;
      mailAudioContextRef.current = null;
      if (context) void context.close();
    },
    [],
  );
  useEffect(() => {
    const baseTitle = "邮件 · YaERP 2.0";
    document.title = summary?.unread
      ? `(${summary.unread}) ${baseTitle}`
      : baseTitle;
    return () => {
      document.title = "YaERP 2.0";
    };
  }, [summary?.unread]);
  const selectFolder = (folder: MailFolder) => {
    if (!folder.selectable) return;
    setCorrespondenceContact(null);
    setSelectedFolder(folder.name);
    setSelected(null);
    setTranslation(null);
    setPage(1);
    setMobilePane("messages");
  };

  const fetchDetail = async (message: MailMessageSummary) => {
    const params = new URLSearchParams({ folder: message.folder });
    const res = await api.get<MailMessageDetail>(
      `/mail/messages/${message.uid}?${params.toString()}`,
    );
    if (res.code !== 0 || !res.data)
      throw new Error(res.message || "无法打开邮件");
    return res.data;
  };

  const openMessage = async (message: MailMessageSummary) => {
    setLoadingDetail(true);
    setMobilePane("detail");
    setTranslation(null);
    try {
      const detail = await fetchDetail(message);
      setSelected(detail);
      setPageData((current) => ({
        ...current,
        messages: current.messages.map((item) =>
          messageKey(item) === messageKey(message)
            ? { ...item, read: true }
            : item,
        ),
      }));
      if (!message.read)
        setFolders((current) =>
          current.map((folder) =>
            folder.name === message.folder
              ? { ...folder, unread: Math.max(0, folder.unread - 1) }
              : folder,
          ),
        );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法打开邮件");
    } finally {
      setLoadingDetail(false);
    }
  };

  const saveAccount = async () => {
    setSavingAccount(true);
    setError("");
    setNotice("");
    try {
      const res = await api.put<MailAccount>("/mail/account", accountInput);
      if (res.code !== 0 || !res.data)
        throw new Error(res.message || "邮箱绑定失败");
      setAccount(res.data);
      setAccountInput((current) => ({ ...current, password: "" }));
      setSettingsOpen(false);
      setNotice("邮箱设置已验证并保存。");
      await loadAccount();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "邮箱绑定失败");
    } finally {
      setSavingAccount(false);
    }
  };

  const testAccount = async () => {
    setTestingAccount(true);
    setError("");
    setNotice("");
    try {
      const res = await api.post<{ message: string }>(
        "/mail/account/test",
        accountInput,
      );
      if (res.code !== 0) throw new Error(res.message || "连接测试失败");
      setNotice(res.data?.message || "IMAP 与 SMTP 连接正常。");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "连接测试失败");
    } finally {
      setTestingAccount(false);
    }
  };

  const runForwarding = async () => {
    setRunningForward(true);
    setError("");
    const res = await api.post("/mail/forward/run", {});
    if (res.code !== 0) setError(res.message || "自动转发检查失败");
    else setNotice("已检查新邮件并执行自动转发。");
    setRunningForward(false);
  };

  const removeAccount = async () => {
    if (!window.confirm("确定解除当前邮箱绑定？邮件仍保留在 poste.io 服务器。"))
      return;
    const res = await api.delete("/mail/account");
    if (res.code !== 0) {
      setError(res.message || "解除绑定失败");
      return;
    }
    setAccount(null);
    setSettingsOpen(false);
    setFolders([]);
    setPageData({
      folder: "INBOX",
      messages: [],
      page: 1,
      page_size: 30,
      total: 0,
      has_more: false,
    });
  };

  const createFolder = async () => {
    const name = window.prompt("新邮件文件夹名称")?.trim();
    if (!name) return;
    const res = await api.post("/mail/folders", { name });
    if (res.code !== 0) {
      setError(res.message || "创建文件夹失败");
      return;
    }
    await loadFolders();
  };

  const renameFolder = async () => {
    if (!selectedFolderMeta || selectedFolderMeta.role !== "folder") return;
    const name = window
      .prompt("重命名邮件文件夹", selectedFolderMeta.name)
      ?.trim();
    if (!name || name === selectedFolderMeta.name) return;
    const res = await api.put("/mail/folders/rename", {
      from: selectedFolderMeta.name,
      to: name,
    });
    if (res.code !== 0) {
      setError(res.message || "重命名失败");
      return;
    }
    setSelectedFolder(name);
    await loadFolders();
  };

  const deleteFolder = async () => {
    if (
      !selectedFolderMeta ||
      selectedFolderMeta.role !== "folder" ||
      !window.confirm(`确定删除文件夹“${selectedFolderMeta.display_name}”？`)
    )
      return;
    const res = await api.delete(
      `/mail/folders?name=${encodeURIComponent(selectedFolderMeta.name)}`,
    );
    if (res.code !== 0) {
      setError(res.message || "删除文件夹失败");
      return;
    }
    setSelectedFolder("INBOX");
    await loadFolders();
  };

  const performBatch = async (
    messages: MailMessageSummary[],
    action: string,
    destination = "",
  ) => {
    if (!messages.length) return;
    if (
      action === "delete" &&
      !window.confirm(`确定删除选中的 ${messages.length} 封邮件？`)
    )
      return;
    setError("");
    const groups = new Map<string, number[]>();
    messages.forEach((message) =>
      groups.set(message.folder, [
        ...(groups.get(message.folder) || []),
        message.uid,
      ]),
    );
    try {
      for (const [folder, uids] of groups) {
        const res = await api.post("/mail/messages/batch", {
          folder,
          action,
          uids,
          destination,
        });
        if (res.code !== 0) throw new Error(res.message || "批量邮件操作失败");
      }
      const affectedKeys = new Set(messages.map(messageKey));
      if (
        selected &&
        affectedKeys.has(messageKey(selected)) &&
        ["delete", "move"].includes(action)
      )
        setSelected(null);
      setSelectedKeys(new Set());
      setNotice(`已完成 ${messages.length} 封邮件的批量操作。`);
      await Promise.all([loadMessages(), loadFolders()]);
    } catch (batchError) {
      setError(
        batchError instanceof Error ? batchError.message : "批量邮件操作失败",
      );
    }
  };

  const performSelectedBatch = (action: string, destination = "") => {
    const messages = pageData.messages.filter((message) =>
      selectedKeys.has(messageKey(message)),
    );
    return performBatch(messages, action, destination);
  };

  const updateFlag = async (field: "read" | "starred", value: boolean) => {
    if (!selected) return;
    const res = await api.put(`/mail/messages/${selected.uid}/flags`, {
      folder: selected.folder,
      [field]: value,
    });
    if (res.code !== 0) {
      setError(res.message || "更新邮件状态失败");
      return;
    }
    setSelected((current) =>
      current ? { ...current, [field]: value } : current,
    );
    setPageData((current) => ({
      ...current,
      messages: current.messages.map((item) =>
        messageKey(item) === messageKey(selected)
          ? { ...item, [field]: value }
          : item,
      ),
    }));
    if (field === "read") await loadFolders();
  };

  const moveSelectedMessage = async (destination: string) => {
    if (!selected || !destination || destination === selected.folder) return;
    await performBatch([selected], "move", destination);
    setMobilePane("messages");
  };

  const filesFromMessage = async (detail: MailMessageDetail) => {
    const files: globalThis.File[] = [];
    for (const attachment of detail.attachments) {
      const response = await api.download(
        `/mail/messages/${detail.uid}/attachments/${encodeURIComponent(attachment.part_id)}?folder=${encodeURIComponent(detail.folder)}`,
      );
      if (!response.ok) continue;
      const blob = await response.blob();
      files.push(
        new globalThis.File([blob], attachment.filename, {
          type: attachment.content_type || blob.type,
        }),
      );
    }
    return files;
  };

  const composeFromDetail = async (
    detail: MailMessageDetail,
    mode: "reply" | "replyAll" | "forward" | "edit",
  ) => {
    const ownAddress = account?.email_address.toLowerCase();
    const baseSubject = detail.subject.replace(/^(re|fwd):\s*/i, "");
    const sender = addressLabel(detail.from);
    const quotedText = `\n\n\n--- ${sender} 于 ${formatDate(detail.date, true)} 写道 ---\n${detail.text_body || ""}`;
    const originalHTML = detail.html_body || textToHTML(detail.text_body || "");
    const quotedHTML = `<p><br></p><blockquote style="margin:0;padding-left:14px;border-left:3px solid #cbd5e1"><div style="color:#64748b">${escapeHTML(sender)} 于 ${escapeHTML(formatDate(detail.date, true))} 写道：</div>${originalHTML}</blockquote>`;
    if (mode === "forward") {
      setCompose({
        ...emptyCompose,
        subject: `Fwd: ${baseSubject}`,
        textBody: quotedText,
        htmlBody: quotedHTML,
        format: detail.html_body ? "html" : "text",
        references: [
          ...(detail.references || []),
          detail.message_id || "",
        ].filter(Boolean),
      });
      setComposeFiles(await filesFromMessage(detail));
    } else if (mode === "edit") {
      const sentByMe = detail.from.some(
        (item) => item.address.toLowerCase() === ownAddress,
      );
      setCompose({
        ...emptyCompose,
        to: addressValues(sentByMe ? detail.to : detail.from),
        cc: sentByMe ? addressValues(detail.cc || []) : "",
        subject: detail.subject,
        textBody: detail.text_body,
        htmlBody: detail.html_body || textToHTML(detail.text_body),
        format: detail.html_body ? "html" : "text",
      });
      setComposeFiles(await filesFromMessage(detail));
    } else {
      const replyTargets = detail.reply_to?.length
        ? detail.reply_to
        : detail.from;
      const all =
        mode === "replyAll"
          ? [...detail.to, ...(detail.cc || [])].filter(
              (item) =>
                item.address.toLowerCase() !== ownAddress &&
                !replyTargets.some(
                  (target) =>
                    target.address.toLowerCase() === item.address.toLowerCase(),
                ),
            )
          : [];
      setCompose({
        ...emptyCompose,
        to: addressValues(replyTargets),
        cc: addressValues(all),
        subject: `Re: ${baseSubject}`,
        textBody: quotedText,
        htmlBody: quotedHTML,
        format: detail.html_body ? "html" : "text",
        inReplyTo: detail.message_id || "",
        references: [
          ...(detail.references || []),
          detail.message_id || "",
        ].filter(Boolean),
      });
      setComposeFiles([]);
    }
    setComposeView("edit");
  };

  const openComposeForMessage = async (
    message: MailMessageSummary,
    mode: "reply" | "replyAll" | "forward" | "edit",
  ) => {
    try {
      const detail =
        selected && messageKey(selected) === messageKey(message)
          ? selected
          : await fetchDetail(message);
      await composeFromDetail(detail, mode);
    } catch (composeError) {
      setError(
        composeError instanceof Error ? composeError.message : "无法读取原邮件",
      );
    }
  };

  const sendMessage = async () => {
    if (!compose || !splitAddresses(compose.to).length) {
      setError("请填写收件人。");
      return;
    }
    setSending(true);
    setError("");
    try {
      const form = new FormData();
      const htmlBody = compose.format === "html" ? compose.htmlBody : "";
      const textBody =
        compose.format === "html"
          ? htmlToText(compose.htmlBody)
          : compose.textBody;
      form.append(
        "payload",
        JSON.stringify({
          to: splitAddresses(compose.to),
          cc: splitAddresses(compose.cc),
          bcc: splitAddresses(compose.bcc),
          subject: compose.subject,
          text_body: textBody,
          html_body: htmlBody,
          in_reply_to: compose.inReplyTo,
          references: compose.references,
          save_to_sent: true,
          priority: compose.priority,
          request_read_receipt: compose.requestReadReceipt,
        }),
      );
      composeFiles.forEach((file) => form.append("attachments", file));
      const res = await api.form<{ message_id: string }>("/mail/send", form);
      if (res.code !== 0) throw new Error(res.message || "发送失败");
      setCompose(null);
      setComposeFiles([]);
      setNotice("邮件已发送。");
      await Promise.all([
        loadFolders(),
        selectedFolderMeta?.role === "sent"
          ? loadMessages()
          : Promise.resolve(),
      ]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  const downloadAttachment = async (attachment: MailAttachment) => {
    if (!selected) return;
    const response = await api.download(
      `/mail/messages/${selected.uid}/attachments/${encodeURIComponent(attachment.part_id)}?folder=${encodeURIComponent(selected.folder)}`,
    );
    if (!response.ok) {
      setError("附件下载失败");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openSaveSender = (message: MailMessageSummary) => {
    const sender = message.from[0];
    if (!sender) return;
    const existing = contacts.find(
      (contact) => contact.email.toLowerCase() === sender.address.toLowerCase(),
    );
    setEditingContactID(
      existing?.source === "saved" && existing.id > 0 ? existing.id : null,
    );
    setContactDraft({
      name: existing?.name || sender.name || "",
      company: existing?.company || "",
      email: sender.address,
      phone: existing?.phone || "",
      notes: existing?.notes || "",
    });
    setContactsOpen(true);
  };

  const saveContact = async () => {
    if (!contactDraft.email.trim()) {
      setError("请填写联系人邮箱。");
      return;
    }
    setSavingContact(true);
    const res = editingContactID
      ? await api.put<MailContact>(
          `/mail/contacts/${editingContactID}`,
          contactDraft,
        )
      : await api.post<MailContact>("/mail/contacts", contactDraft);
    if (res.code !== 0) setError(res.message || "保存联系人失败");
    else {
      setNotice("联系人已保存。");
      setEditingContactID(null);
      setContactDraft(emptyContact);
      await loadContacts();
    }
    setSavingContact(false);
  };

  const deleteContact = async (contact: MailContact) => {
    if (
      contact.source !== "saved" ||
      contact.id <= 0 ||
      !window.confirm(`确定删除联系人“${contact.name || contact.email}”？`)
    )
      return;
    const res = await api.delete(`/mail/contacts/${contact.id}`);
    if (res.code !== 0) setError(res.message || "删除联系人失败");
    else await loadContacts();
  };

  const editContact = (contact: MailContact) => {
    if (contact.source !== "saved" || contact.id <= 0) return;
    setEditingContactID(contact.id);
    setContactDraft({
      trade_customer_id: contact.trade_customer_id,
      name: contact.name,
      company: contact.company,
      email: contact.email,
      phone: contact.phone || "",
      notes: contact.notes || "",
    });
  };

  const toggleContact = (contact: MailContact) => {
    const key = contactKey(contact);
    setSelectedContactKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllFilteredContacts = () => {
    setSelectedContactKeys((current) => {
      const next = new Set(current);
      if (allFilteredContactsSelected) {
        filteredContacts.forEach((contact) => next.delete(contactKey(contact)));
      } else {
        filteredContacts.forEach((contact) => next.add(contactKey(contact)));
      }
      return next;
    });
  };

  const writeSelectedContacts = (append = false) => {
    if (selectedContacts.length === 0) return;
    if (append && compose) {
      setCompose((current) => {
        if (!current) return current;
        return selectedContacts.reduce(
          (next, contact) => ({
            ...next,
            to: appendAddress(next.to, contact),
          }),
          current,
        );
      });
    } else {
      setCompose({
        ...emptyCompose,
        to: selectedContacts
          .map((contact) =>
            contact.name
              ? `${contact.name} <${contact.email}>`
              : contact.email,
          )
          .join("; "),
      });
      setComposeFiles([]);
      setComposeView("edit");
    }
    setContactsOpen(false);
    setSelectedContactKeys(new Set());
  };

  const deleteSelectedContacts = async () => {
    const removable = selectedContacts.filter(
      (contact) => contact.source === "saved" && contact.id > 0,
    );
    if (
      removable.length === 0 ||
      !window.confirm(`确定删除选中的 ${removable.length} 位个人联系人？`)
    )
      return;
    const results = await Promise.all(
      removable.map((contact) => api.delete(`/mail/contacts/${contact.id}`)),
    );
    const failed = results.find((result) => result.code !== 0);
    if (failed) setError(failed.message || "部分联系人删除失败");
    else setNotice(`已删除 ${removable.length} 位联系人。`);
    setSelectedContactKeys(new Set());
    await loadContacts();
  };

  const viewCorrespondence = (contact: MailContact) => {
    setCorrespondenceContact(contact);
    setContactsOpen(false);
    setSelectedContactKeys(new Set());
    setSelected(null);
    setPage(1);
    setSearchDraft("");
    setSearchQuery("");
    setMobilePane("messages");
  };

  const writeToContact = (contact: MailContact) => {
    setCompose({
      ...emptyCompose,
      to: contact.name ? `${contact.name} <${contact.email}>` : contact.email,
    });
    setComposeFiles([]);
    setComposeView("edit");
    setContactsOpen(false);
    setSelectedContactKeys(new Set());
  };

  const translateText = async (source: string) => {
    if (!source.trim()) {
      setError("没有可翻译的内容。");
      return;
    }
    setTranslating(true);
    setError("");
    const res = await api.post<AITranslationResult>("/mail/translate", {
      source_text: source.slice(0, 24000),
      target_language: targetLanguage,
      assistant_id: assistantID,
      aligned: true,
    });
    if (res.code !== 0 || !res.data?.content)
      setError(res.message || "邮件翻译失败");
    else setTranslation(res.data);
    setTranslating(false);
  };

  const openContextMenu = (event: MouseEvent, message: MailMessageSummary) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 430)),
      message,
    });
  };

  const contextTargets = (message: MailMessageSummary) => {
    if (selectedKeys.has(messageKey(message)) && selectedKeys.size > 1)
      return pageData.messages.filter((item) =>
        selectedKeys.has(messageKey(item)),
      );
    return [message];
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setSearchQuery(searchDraft.trim());
  };

  const toggleMessage = (message: MailMessageSummary) => {
    const key = messageKey(message);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (allVisibleSelected)
        pageData.messages.forEach((message) =>
          next.delete(messageKey(message)),
        );
      else
        pageData.messages.forEach((message) => next.add(messageKey(message)));
      return next;
    });
  };

  if (account === undefined)
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在载入邮件客户端
        </div>
      </AuthGuard>
    );

  if (!account) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-slate-100 p-3 sm:p-6">
          <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4 sm:px-6">
              <button
                type="button"
                onClick={() => router.push("/")}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                title="返回首页"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                <Mail className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-950">
                  绑定工作邮箱
                </h1>
                <p className="mt-0.5 text-sm text-slate-500">
                  使用你的 poste.io 邮箱收发邮件
                </p>
              </div>
            </div>
            <AccountForm
              value={accountInput}
              onChange={setAccountInput}
              existing={false}
            />
            <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex items-start gap-2 text-xs text-slate-500">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                密码使用服务器密钥加密保存，管理员无法查看你的邮件和密码。
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void testAccount()}
                  disabled={testingAccount}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-700 disabled:opacity-50"
                >
                  {testingAccount && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  测试连接
                </button>
                <button
                  type="button"
                  onClick={() => void saveAccount()}
                  disabled={savingAccount}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {savingAccount ? "验证中..." : "验证并保存"}
                </button>
              </div>
            </div>
            {(error || notice) && (
              <StatusMessage error={error} notice={notice} />
            )}
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="h-screen overflow-hidden bg-slate-100 text-slate-800">
        <header className="flex h-16 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:px-4">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
            title="返回首页"
            aria-label="返回首页"
            data-tooltip="返回首页"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white">
            <Mail className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-950">
              {account.display_name || account.email_address}
            </div>
            <div className="truncate text-[11px] text-slate-400">
              {account.email_address}
              {summary ? ` · ${summary.unread} 封未读` : ""}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setCompose(emptyCompose);
                setComposeFiles([]);
                setComposeView("edit");
              }}
              className="ui-tooltip inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white hover:bg-sky-700"
              title="新建邮件"
              aria-label="新建邮件"
              data-tooltip="新建邮件"
            >
              <Pencil className="h-4 w-4" />
              <span className="hidden sm:inline">写邮件</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setContactSourceFilter("all");
                setSelectedContactKeys(new Set());
                setContactsOpen(true);
              }}
              className="ui-tooltip flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
              title="邮箱通讯录"
              aria-label="邮箱通讯录"
              data-tooltip="邮箱通讯录"
            >
              <BookUser className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() =>
                void Promise.all([
                  loadFolders(),
                  loadMessages(),
                  loadContacts(),
                ])
              }
              className="ui-tooltip flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
              title="刷新邮件"
              aria-label="刷新邮件"
              data-tooltip="刷新邮件"
            >
              <RefreshCw
                className={`h-4 w-4 ${loadingMessages ? "animate-spin" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="ui-tooltip flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
              title="邮箱设置"
              aria-label="邮箱设置"
              data-tooltip="邮箱设置"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </header>

        {(error || notice) && (
          <div className="fixed left-1/2 top-[72px] z-[80] w-[calc(100%-24px)] max-w-xl -translate-x-1/2">
            <StatusMessage
              error={error}
              notice={notice}
              compact
              onClose={() => {
                setError("");
                setNotice("");
              }}
            />
          </div>
        )}

        <main className="grid h-[calc(100dvh-4rem)] min-h-0 md:grid-cols-[210px_minmax(300px,390px)_minmax(0,1fr)]">
          <aside
            className={`${mobilePane === "folders" ? "flex" : "hidden"} min-h-0 flex-col border-r border-slate-200 bg-slate-50 md:flex`}
          >
            <div className="flex h-14 shrink-0 items-center justify-between px-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                邮件文件夹
              </span>
              <button
                type="button"
                onClick={() => void createFolder()}
                className="ui-tooltip flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-white"
                title="新建邮件文件夹"
                aria-label="新建邮件文件夹"
                data-tooltip="新建邮件文件夹"
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[46%] min-h-24 shrink-0 overflow-y-auto px-2 pb-3">
              {loadingFolders && folders.length === 0 ? (
                <div className="p-5 text-center text-xs text-slate-400">
                  正在读取文件夹...
                </div>
              ) : (
                folders.map((folder) => {
                  const Icon = folderIcon(folder.role);
                  const active =
                    !correspondenceContact && selectedFolder === folder.name;
                  return (
                    <button
                      key={folder.name}
                      type="button"
                      onClick={() => selectFolder(folder)}
                      disabled={!folder.selectable}
                      className={`mb-0.5 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition ${active ? "bg-white font-semibold text-sky-700 shadow-sm" : folder.selectable ? "text-slate-600 hover:bg-white" : "cursor-default text-slate-400"}`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {folder.display_name}
                      </span>
                      {folder.unread > 0 && (
                        <span className="rounded-full bg-sky-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {folder.unread > 99 ? "99+" : folder.unread}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
            {selectedFolderMeta?.role === "folder" &&
              !correspondenceContact && (
                <div className="flex gap-2 border-t border-slate-200 p-3">
                  <button
                    type="button"
                    onClick={() => void renameFolder()}
                    className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-600"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteFolder()}
                    className="ui-tooltip flex h-8 w-9 items-center justify-center rounded-lg border border-rose-200 bg-white text-rose-600"
                    title="删除文件夹"
                    aria-label="删除文件夹"
                    data-tooltip="删除文件夹"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200 bg-white/60 p-2">
              <button
                type="button"
                onClick={() => {
                  setContactQuery("");
                  setContactSourceFilter("all");
                  setSelectedContactKeys(new Set());
                  setContactsOpen(true);
                }}
                className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-white"
              >
                <BookUser className="h-4 w-4 text-sky-600" />
                <span className="min-w-0 flex-1">通讯录</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                  {contacts.length}
                </span>
              </button>
              <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                联系人
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {contacts.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setContactsOpen(true)}
                    className="mt-1 flex w-full flex-col items-center rounded-lg border border-dashed border-slate-200 px-3 py-5 text-xs text-slate-400 hover:border-sky-200 hover:text-sky-600"
                  >
                    <UserPlus className="mb-1.5 h-4 w-4" />
                    新建第一个联系人
                  </button>
                ) : (
                  contacts.slice(0, 8).map((contact) => (
                    <button
                      key={contactKey(contact)}
                      type="button"
                      onClick={() => viewCorrespondence(contact)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white"
                      title={`查看与 ${contact.name || contact.email} 的往来邮件`}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${contact.source === "erp" ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-700"}`}
                      >
                        {(contact.name || contact.email)
                          .slice(0, 2)
                          .toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-slate-700">
                          {contact.name || contact.company || contact.email}
                        </span>
                        <span className="block truncate text-[10px] text-slate-400">
                          {contact.email}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </aside>

          <section
            className={`${mobilePane === "messages" ? "flex" : "hidden"} min-h-0 flex-col border-r border-slate-200 bg-white md:flex`}
          >
            <div className="border-b border-slate-200 p-3">
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMobilePane("folders")}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 md:hidden"
                  title="邮件文件夹"
                >
                  <Menu className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold text-slate-900">
                    {correspondenceContact
                      ? `与 ${correspondenceContact.name || correspondenceContact.email} 的往来`
                      : selectedFolderMeta?.display_name || selectedFolder}
                  </h2>
                  <div className="mt-0.5 text-xs text-slate-400">
                    {pageData.total} 封邮件
                  </div>
                </div>
                {correspondenceContact && (
                  <button
                    type="button"
                    onClick={() => {
                      setCorrespondenceContact(null);
                      setPage(1);
                    }}
                    className="flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-500"
                  >
                    <X className="h-3.5 w-3.5" />
                    退出往来
                  </button>
                )}
                {!correspondenceContact && (
                  <div ref={filterMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setFilterMenuOpen((current) => !current)}
                      className={`ui-tooltip inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${filterMode !== "all" || startDate || endDate || sortBy !== "date" || sortOrder !== "desc" ? "border-sky-200 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                      title="筛选和排序邮件"
                      aria-label="筛选和排序邮件"
                      data-tooltip="筛选和排序"
                    >
                      <ListFilter className="h-3.5 w-3.5" />
                      筛选
                    </button>
                    {filterMenuOpen && (
                      <div className="absolute right-0 top-10 z-40 w-[min(300px,calc(100vw-24px))] rounded-lg border border-slate-200 bg-white p-2 shadow-2xl">
                        <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          筛选邮件
                        </div>
                        {(
                          [
                            ["all", "全部"],
                            ["unread", "未读"],
                            ["attachment", "包含附件"],
                            ["contacts", "来自联系人"],
                          ] as Array<[MailFilterMode, string]>
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setFilterMode(value)}
                            className="flex h-9 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                          >
                            {label}
                            {filterMode === value && (
                              <Check className="h-4 w-4 text-sky-600" />
                            )}
                          </button>
                        ))}
                        <div className="my-2 border-t border-slate-100" />
                        <div className="flex items-center gap-1.5 px-2 pb-2 text-xs font-medium text-slate-600">
                          <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                          日期范围
                        </div>
                        <div className="grid grid-cols-2 gap-2 px-2">
                          <label className="text-[10px] text-slate-400">
                            开始日期
                            <input
                              type="date"
                              value={startDate}
                              max={endDate || undefined}
                              onChange={(event) =>
                                setStartDate(event.target.value)
                              }
                              className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-xs text-slate-700 outline-none focus:border-sky-400"
                            />
                          </label>
                          <label className="text-[10px] text-slate-400">
                            结束日期
                            <input
                              type="date"
                              value={endDate}
                              min={startDate || undefined}
                              onChange={(event) =>
                                setEndDate(event.target.value)
                              }
                              className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-xs text-slate-700 outline-none focus:border-sky-400"
                            />
                          </label>
                        </div>
                        <div className="my-2 border-t border-slate-100" />
                        <div className="flex items-center gap-1.5 px-2 pb-2 text-xs font-medium text-slate-600">
                          <ArrowUpDown className="h-3.5 w-3.5 text-slate-400" />
                          排序方式
                        </div>
                        <div className="grid grid-cols-2 gap-2 px-2">
                          <button
                            type="button"
                            onClick={() => setSortBy("date")}
                            className={`h-8 rounded-lg border text-xs ${sortBy === "date" ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600"}`}
                          >
                            按日期
                          </button>
                          <button
                            type="button"
                            onClick={() => setSortBy("size")}
                            className={`h-8 rounded-lg border text-xs ${sortBy === "size" ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600"}`}
                          >
                            按大小
                          </button>
                          <button
                            type="button"
                            onClick={() => setSortOrder("desc")}
                            title="日期由新到旧，或大小由大到小"
                            className={`h-8 rounded-lg border text-xs ${sortOrder === "desc" ? "border-slate-400 bg-slate-100 text-slate-800" : "border-slate-200 text-slate-600"}`}
                          >
                            降序
                          </button>
                          <button
                            type="button"
                            onClick={() => setSortOrder("asc")}
                            title="日期由旧到新，或大小由小到大"
                            className={`h-8 rounded-lg border text-xs ${sortOrder === "asc" ? "border-slate-400 bg-slate-100 text-slate-800" : "border-slate-200 text-slate-600"}`}
                          >
                            升序
                          </button>
                        </div>
                        <div className="mt-2 flex justify-between border-t border-slate-100 px-2 pt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setFilterMode("all");
                              setStartDate("");
                              setEndDate("");
                              setSortBy("date");
                              setSortOrder("desc");
                            }}
                            className="h-8 px-2 text-xs text-slate-500 hover:text-slate-800"
                          >
                            重置
                          </button>
                          <button
                            type="button"
                            onClick={() => setFilterMenuOpen(false)}
                            className="h-8 rounded-lg bg-slate-900 px-3 text-xs font-medium text-white"
                          >
                            完成
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {!correspondenceContact && (
                <form onSubmit={submitSearch} className="flex gap-2">
                  <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3">
                    <Search className="h-4 w-4 shrink-0 text-slate-400" />
                    <input
                      value={searchDraft}
                      onChange={(event) => setSearchDraft(event.target.value)}
                      placeholder="搜索发件人、主题或正文"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                    {searchDraft && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchDraft("");
                          setSearchQuery("");
                          setPage(1);
                        }}
                        title="清除搜索"
                      >
                        <X className="h-3.5 w-3.5 text-slate-400" />
                      </button>
                    )}
                  </label>
                  <button
                    type="submit"
                    className="h-9 rounded-lg bg-slate-900 px-3 text-xs font-medium text-white"
                  >
                    搜索
                  </button>
                </form>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleAllVisible}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2 text-xs text-slate-600"
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                  {allVisibleSelected ? "取消全选" : "全选本页"}
                </button>
                {!correspondenceContact &&
                  (filterMode !== "all" || startDate || endDate) && (
                    <span className="min-w-0 truncate text-xs text-sky-700">
                      {filterMode === "unread"
                        ? "未读邮件"
                        : filterMode === "attachment"
                          ? "包含附件"
                          : filterMode === "contacts"
                            ? "来自联系人"
                            : "全部邮件"}
                      {startDate || endDate
                        ? ` · ${startDate || "最早"} 至 ${endDate || "今天"}`
                        : ""}
                    </span>
                  )}
              </div>
            </div>
            {selectedKeys.size > 0 && (
              <div className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-sky-100 bg-sky-50 px-3">
                <span className="mr-2 shrink-0 text-xs font-semibold text-sky-800">
                  已选 {selectedKeys.size} 封
                </span>
                <button
                  type="button"
                  onClick={() => void performSelectedBatch("read")}
                  className="h-8 shrink-0 rounded-lg px-2 text-xs text-slate-600 hover:bg-white"
                >
                  标为已读
                </button>
                <button
                  type="button"
                  onClick={() => void performSelectedBatch("unread")}
                  className="h-8 shrink-0 rounded-lg px-2 text-xs text-slate-600 hover:bg-white"
                >
                  标为未读
                </button>
                <button
                  type="button"
                  onClick={() => void performSelectedBatch("star")}
                  className="h-8 shrink-0 rounded-lg px-2 text-xs text-slate-600 hover:bg-white"
                >
                  加星标
                </button>
                <label className="flex h-8 shrink-0 items-center rounded-lg bg-white px-2 text-xs text-slate-600">
                  <Folder className="mr-1 h-3.5 w-3.5" />
                  <select
                    value=""
                    onChange={(event) =>
                      void performSelectedBatch("move", event.target.value)
                    }
                    className="bg-transparent outline-none"
                  >
                    <option value="">移动到</option>
                    {folders
                      .filter((folder) => folder.selectable)
                      .map((folder) => (
                        <option key={folder.name} value={folder.name}>
                          {folder.display_name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void performSelectedBatch("delete")}
                  className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-rose-600 hover:bg-rose-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  批量删除
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loadingMessages ? (
                <div className="flex h-40 items-center justify-center text-sm text-slate-400">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在读取邮件
                </div>
              ) : pageData.messages.length === 0 ? (
                <div className="flex h-52 flex-col items-center justify-center text-sm text-slate-400">
                  <MailOpen className="mb-3 h-9 w-9 text-slate-300" />
                  没有匹配的邮件
                </div>
              ) : (
                pageData.messages.map((message) => (
                  <div
                    key={messageKey(message)}
                    role="button"
                    tabIndex={0}
                    onClick={() => void openMessage(message)}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                      if (event.key === "Enter") void openMessage(message);
                    }}
                    onContextMenu={(event) => openContextMenu(event, message)}
                    className={`flex w-full cursor-pointer gap-2 border-b border-slate-100 px-3 py-3 text-left transition hover:bg-slate-50 ${selected && messageKey(selected) === messageKey(message) ? "bg-sky-50" : "bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(messageKey(message))}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleMessage(message)}
                      className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                      aria-label={`选择邮件 ${message.subject}`}
                    />
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${message.read ? "bg-transparent" : "bg-sky-500"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${message.read ? "font-medium text-slate-700" : "font-semibold text-slate-950"}`}
                        >
                          {addressLabel(message.from)}
                        </span>
                        <span className="shrink-0 text-[11px] text-slate-400">
                          {formatDate(message.date)}
                        </span>
                      </div>
                      <div
                        className={`mt-1 truncate text-sm ${message.read ? "text-slate-500" : "font-medium text-slate-800"}`}
                      >
                        {message.subject}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                        {message.starred && (
                          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                        )}
                        {message.has_attachment && (
                          <>
                            <Paperclip className="h-3 w-3" />
                            附件
                          </>
                        )}
                        <span>{formatBytes(message.size)}</span>
                        {correspondenceContact && (
                          <span className="truncate">· {message.folder}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="flex h-12 shrink-0 items-center justify-between border-t border-slate-200 px-3 text-xs text-slate-500">
              <span>第 {pageData.page} 页</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 disabled:opacity-40"
                  title="上一页"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={!pageData.has_more}
                  onClick={() => setPage((current) => current + 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 disabled:opacity-40"
                  title="下一页"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>

          <section
            className={`${mobilePane === "detail" ? "flex" : "hidden"} min-h-0 flex-col bg-white md:flex`}
          >
            {loadingDetail ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在打开邮件
              </div>
            ) : !selected ? (
              <div className="flex h-full min-h-80 flex-col items-center justify-center text-sm text-slate-400">
                <Mail className="mb-3 h-10 w-10 text-slate-200" />
                选择一封邮件查看内容
              </div>
            ) : (
              <>
                <div className="flex min-h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 px-2 sm:px-3 md:overflow-visible">
                  <button
                    type="button"
                    onClick={() => setMobilePane("messages")}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 md:hidden"
                    title="返回邮件列表"
                    aria-label="返回邮件列表"
                    data-tooltip="返回邮件列表"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void composeFromDetail(selected, "reply")}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    title="回复"
                    aria-label="回复"
                    data-tooltip="回复"
                  >
                    <Reply className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void composeFromDetail(selected, "replyAll")}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    title="回复全部"
                    aria-label="回复全部"
                    data-tooltip="回复全部"
                  >
                    <ReplyAll className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void composeFromDetail(selected, "forward")}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    title="转发"
                    aria-label="转发"
                    data-tooltip="转发"
                  >
                    <Forward className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void composeFromDetail(selected, "edit")}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    title="复制并编辑为新邮件"
                    aria-label="复制并编辑为新邮件"
                    data-tooltip="复制并编辑为新邮件"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openSaveSender(selected)}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    title="保存发件人"
                    aria-label="保存发件人"
                    data-tooltip="保存发件人"
                  >
                    <UserPlus className="h-4 w-4" />
                  </button>
                  <div className="mx-1 h-5 w-px shrink-0 bg-slate-200" />
                  <button
                    type="button"
                    onClick={() =>
                      void updateFlag("starred", !selected.starred)
                    }
                    className={`ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 ${selected.starred ? "text-amber-500" : "text-slate-500"}`}
                    title={selected.starred ? "取消星标" : "添加星标"}
                    aria-label={selected.starred ? "取消星标" : "添加星标"}
                    data-tooltip={selected.starred ? "取消星标" : "添加星标"}
                  >
                    <Star
                      className={`h-4 w-4 ${selected.starred ? "fill-current" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateFlag("read", !selected.read)}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    title={selected.read ? "标记未读" : "标记已读"}
                    aria-label={selected.read ? "标记未读" : "标记已读"}
                    data-tooltip={selected.read ? "标记未读" : "标记已读"}
                  >
                    {selected.read ? (
                      <Mail className="h-4 w-4" />
                    ) : (
                      <MailOpen className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void translateText(
                        selected.text_body.trim() ||
                          htmlToText(selected.html_body),
                      )
                    }
                    className="ui-tooltip inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                    title="使用 AI 按原文逐段对照翻译整封邮件"
                    aria-label="全文对照翻译"
                    data-tooltip="全文对照翻译"
                  >
                    <Languages className="h-4 w-4" />
                    全文对照翻译
                  </button>
                  <label
                    className="ui-tooltip ml-auto flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-slate-500 hover:bg-slate-100"
                    title="移动到文件夹"
                    data-tooltip="移动到其他邮件文件夹"
                  >
                    <Folder className="h-4 w-4" />
                    <select
                      value=""
                      onChange={(event) =>
                        void moveSelectedMessage(event.target.value)
                      }
                      className="max-w-24 bg-transparent text-xs outline-none"
                    >
                      <option value="">移动</option>
                      {folders
                        .filter(
                          (folder) =>
                            folder.selectable &&
                            folder.name !== selected.folder,
                        )
                        .map((folder) => (
                          <option key={folder.name} value={folder.name}>
                            {folder.display_name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void performBatch([selected], "delete")}
                    className="ui-tooltip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50"
                    title="删除邮件"
                    aria-label="删除邮件"
                    data-tooltip="删除邮件"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                  <h2 className="text-xl font-semibold leading-8 text-slate-950">
                    {selected.subject}
                  </h2>
                  <div className="mt-4 flex items-start gap-3 border-b border-slate-100 pb-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sky-50 text-sm font-semibold text-sky-700">
                      {selected.sender_avatar ? (
                        <img
                          src={selected.sender_avatar}
                          alt={`${addressLabel(selected.from)} 的头像`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        addressLabel(selected.from).slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-sm font-semibold text-slate-800">
                          {selected.from[0]?.name ||
                            selected.from[0]?.address ||
                            "未知发件人"}
                        </span>
                        {selected.from[0]?.address &&
                          selected.from[0].address !==
                            selected.from[0]?.name && (
                            <span className="break-all text-xs font-normal text-slate-500">
                              {selected.from[0].address}
                            </span>
                          )}
                      </div>
                      <div className="mt-0.5 break-all text-xs text-slate-500">
                        发给 {addressLabel(selected.to)}
                        {selected.cc?.length
                          ? `，抄送 ${addressLabel(selected.cc)}`
                          : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-slate-400">
                      {formatDate(selected.date, true)}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <select
                      value={targetLanguage}
                      onChange={(event) =>
                        setTargetLanguage(event.target.value)
                      }
                      className="h-8 rounded-lg border border-slate-200 bg-white px-2"
                    >
                      {translationLanguages.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {assistants.length > 1 && (
                      <select
                        value={assistantID}
                        onChange={(event) =>
                          setAssistantID(Number(event.target.value))
                        }
                        className="h-8 max-w-52 rounded-lg border border-slate-200 bg-white px-2"
                      >
                        {assistants.map((assistant) => (
                          <option key={assistant.id} value={assistant.id}>
                            {assistant.name} · {assistant.model}
                          </option>
                        ))}
                      </select>
                    )}
                    {translating && (
                      <span className="inline-flex items-center gap-1 text-indigo-600">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        AI 正在生成全文对照译文
                      </span>
                    )}
                    {translation && (
                      <span className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 text-emerald-700">
                        正在显示逐段对照译文 ·{" "}
                        {translation.assistant_name || translation.model}
                        <button
                          type="button"
                          onClick={() => {
                            setTranslation(null);
                          }}
                          className="ui-tooltip rounded text-emerald-600 hover:text-emerald-800"
                          title="恢复原始邮件"
                          aria-label="恢复原始邮件"
                          data-tooltip="恢复原始邮件"
                          data-tooltip-side="top"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  {selected.attachments.some(
                    (attachment) => !attachment.inline,
                  ) && (
                    <div className="flex flex-wrap gap-2 border-b border-slate-100 py-3">
                      {selected.attachments
                        .filter((attachment) => !attachment.inline)
                        .map((attachment) => (
                          <button
                            key={attachment.part_id}
                            type="button"
                            onClick={() => void downloadAttachment(attachment)}
                            className="flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
                          >
                            <File className="h-4 w-4 shrink-0 text-sky-600" />
                            <span className="min-w-0">
                              <span className="block max-w-56 truncate text-xs font-medium text-slate-700">
                                {attachment.filename}
                              </span>
                              <span className="block text-[10px] text-slate-400">
                                {formatBytes(attachment.size)}
                              </span>
                            </span>
                            <Download className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          </button>
                        ))}
                    </div>
                  )}
                  <div className="py-5">
                    <iframe
                      title="邮件正文"
                      sandbox=""
                      srcDoc={iframeDocument(displayedMailHTML)}
                      className="min-h-[55dvh] w-full border-0"
                    />
                  </div>
                </div>
              </>
            )}
          </section>
        </main>
      </div>

      {contextMenu && (
        <div
          className="fixed z-[100] w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-2xl"
          style={{ left: contextMenu.x, top: Math.max(8, contextMenu.y) }}
          onClick={(event) => event.stopPropagation()}
        >
          <ContextButton
            icon={MailOpen}
            label="打开邮件"
            onClick={() => void openMessage(contextMenu.message)}
          />
          <ContextButton
            icon={Reply}
            label="回复"
            onClick={() =>
              void openComposeForMessage(contextMenu.message, "reply")
            }
          />
          <ContextButton
            icon={ReplyAll}
            label="回复全部"
            onClick={() =>
              void openComposeForMessage(contextMenu.message, "replyAll")
            }
          />
          <ContextButton
            icon={Forward}
            label="转发"
            onClick={() =>
              void openComposeForMessage(contextMenu.message, "forward")
            }
          />
          <ContextButton
            icon={Copy}
            label="复制并编辑"
            onClick={() =>
              void openComposeForMessage(contextMenu.message, "edit")
            }
          />
          <ContextButton
            icon={UserPlus}
            label="保存发件人"
            onClick={() => openSaveSender(contextMenu.message)}
          />
          <div className="my-1 border-t border-slate-100" />
          <ContextButton
            icon={contextMenu.message.read ? Mail : MailOpen}
            label={contextMenu.message.read ? "标为未读" : "标为已读"}
            onClick={() =>
              void performBatch(
                contextTargets(contextMenu.message),
                contextMenu.message.read ? "unread" : "read",
              )
            }
          />
          <ContextButton
            icon={Star}
            label={contextMenu.message.starred ? "取消星标" : "添加星标"}
            onClick={() =>
              void performBatch(
                contextTargets(contextMenu.message),
                contextMenu.message.starred ? "unstar" : "star",
              )
            }
          />
          {folders.find((folder) => folder.role === "archive") && (
            <ContextButton
              icon={Archive}
              label="归档"
              onClick={() =>
                void performBatch(
                  contextTargets(contextMenu.message),
                  "move",
                  folders.find((folder) => folder.role === "archive")!.name,
                )
              }
            />
          )}
          <label className="flex h-9 w-full items-center gap-2.5 px-3 text-sm text-slate-700 hover:bg-slate-50">
            <Folder className="h-4 w-4 shrink-0" />
            <select
              value=""
              onChange={(event) => {
                const destination = event.target.value;
                if (!destination) return;
                void performBatch(
                  contextTargets(contextMenu.message),
                  "move",
                  destination,
                );
                setContextMenu(null);
              }}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            >
              <option value="">移动到文件夹</option>
              {folders
                .filter(
                  (folder) =>
                    folder.selectable &&
                    folder.name !== contextMenu.message.folder,
                )
                .map((folder) => (
                  <option key={folder.name} value={folder.name}>
                    {folder.display_name}
                  </option>
                ))}
            </select>
          </label>
          <ContextButton
            icon={Trash2}
            label={
              selectedKeys.size > 1 &&
              selectedKeys.has(messageKey(contextMenu.message))
                ? `删除所选 ${selectedKeys.size} 封`
                : "删除邮件"
            }
            danger
            onClick={() =>
              void performBatch(contextTargets(contextMenu.message), "delete")
            }
          />
        </div>
      )}

      {settingsOpen && (
        <ModalShell
          title="邮箱设置"
          subtitle="发件资料、HTML 签名和自动转发"
          onClose={() => setSettingsOpen(false)}
          maxWidth="max-w-3xl"
        >
          <div className="min-h-0 overflow-y-auto">
            <AccountForm
              value={accountInput}
              onChange={setAccountInput}
              existing
            />
            {(error || notice) && (
              <StatusMessage error={error} notice={notice} />
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <button
              type="button"
              onClick={() => void removeAccount()}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-rose-200 px-3 text-sm text-rose-600"
            >
              <Trash2 className="h-4 w-4" />
              解除绑定
            </button>
            <div className="flex flex-wrap justify-end gap-2">
              {accountInput.auto_forward_enabled && (
                <button
                  type="button"
                  onClick={() => void runForwarding()}
                  disabled={runningForward}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-sky-200 px-3 text-sm text-sky-700 disabled:opacity-50"
                >
                  {runningForward ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Forward className="h-4 w-4" />
                  )}
                  立即检查转发
                </button>
              )}
              <button
                type="button"
                onClick={() => void testAccount()}
                disabled={testingAccount}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 disabled:opacity-50"
              >
                {testingAccount && <Loader2 className="h-4 w-4 animate-spin" />}
                测试
              </button>
              <button
                type="button"
                onClick={() => void saveAccount()}
                disabled={savingAccount}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                保存
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {contactsOpen && (
        <ModalShell
          title="邮箱通讯录"
          subtitle="集中管理 ERP 客户和个人联系人，可批量写信或查询历史往来"
          onClose={() => {
            setContactsOpen(false);
            setSelectedContactKeys(new Set());
          }}
          maxWidth="max-w-6xl"
        >
          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(320px,1fr)_auto] lg:grid-cols-[180px_minmax(0,1fr)_320px] lg:grid-rows-1">
            <aside className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-slate-50 p-3 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r">
              <div className="hidden px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 lg:block">
                联系人来源
              </div>
              {(
                [
                  ["all", "全部联系人", contactCounts.all],
                  ["erp", "ERP 客户", contactCounts.erp],
                  ["saved", "个人联系人", contactCounts.saved],
                ] as Array<[ContactSourceFilter, string, number]>
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setContactSourceFilter(value);
                    setSelectedContactKeys(new Set());
                  }}
                  className={`flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition lg:w-full ${contactSourceFilter === value ? "bg-white font-semibold text-sky-700 shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  <BookUser className="h-4 w-4" />
                  <span className="min-w-0 flex-1 text-left">{label}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                    {count}
                  </span>
                </button>
              ))}
              <div className="mt-auto hidden rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-xs leading-5 text-emerald-700 lg:block">
                ERP 客户由业务系统同步，只能查看往来和写邮件；个人联系人可编辑或删除。
              </div>
            </aside>

            <section className="flex min-h-0 flex-col border-b border-slate-200 bg-white lg:border-b-0 lg:border-r">
              <div className="shrink-0 border-b border-slate-200 p-3 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-900">
                      {contactSourceFilter === "all"
                        ? "全部联系人"
                        : contactSourceFilter === "erp"
                          ? "ERP 客户"
                          : "个人联系人"}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      当前显示 {filteredContacts.length} 位联系人
                    </div>
                  </div>
                  <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 sm:max-w-sm">
                    <Search className="h-4 w-4 shrink-0 text-slate-400" />
                    <input
                      value={contactQuery}
                      onChange={(event) => setContactQuery(event.target.value)}
                      placeholder="搜索姓名、公司、邮箱或电话"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                    {contactQuery && (
                      <button
                        type="button"
                        onClick={() => setContactQuery("")}
                        className="text-slate-400 hover:text-slate-600"
                        title="清空搜索"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleAllFilteredContacts}
                    disabled={filteredContacts.length === 0}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 disabled:opacity-40"
                  >
                    <CheckSquare className="h-4 w-4" />
                    {allFilteredContactsSelected ? "取消全选" : "全选当前"}
                  </button>
                  <button
                    type="button"
                    onClick={() => writeSelectedContacts(Boolean(compose))}
                    disabled={selectedContacts.length === 0}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    {compose ? (
                      <UserPlus className="h-4 w-4" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {compose ? "加入收件人" : "写邮件"}
                    {selectedContacts.length > 0 &&
                      ` (${selectedContacts.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSelectedContacts()}
                    disabled={selectedSavedContactCount === 0}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 px-3 text-xs font-medium text-rose-600 disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                    删除个人联系人
                    {selectedSavedContactCount > 0 &&
                      ` (${selectedSavedContactCount})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingContactID(null);
                      setContactDraft(emptyContact);
                    }}
                    className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600"
                  >
                    <UserPlus className="h-4 w-4" />
                    新建联系人
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {filteredContacts.length === 0 ? (
                  <div className="flex h-full min-h-52 flex-col items-center justify-center px-6 text-center text-sm text-slate-400">
                    <BookUser className="mb-3 h-8 w-8 text-slate-300" />
                    <div>没有匹配的联系人</div>
                    <div className="mt-1 text-xs">
                      可以调整筛选条件，或在右侧新建个人联系人。
                    </div>
                  </div>
                ) : (
                  <div className="min-w-[680px]">
                    <div className="grid grid-cols-[36px_minmax(150px,1fr)_minmax(190px,1.3fr)_minmax(120px,.8fr)_146px] items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-500">
                      <span />
                      <span>联系人</span>
                      <span>邮箱</span>
                      <span>公司 / 来源</span>
                      <span className="text-right">操作</span>
                    </div>
                    {filteredContacts.map((contact) => {
                      const checked = selectedContactKeys.has(
                        contactKey(contact),
                      );
                      return (
                        <div
                          key={contactKey(contact)}
                          className={`grid grid-cols-[36px_minmax(150px,1fr)_minmax(190px,1.3fr)_minmax(120px,.8fr)_146px] items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 ${checked ? "bg-sky-50/70" : "hover:bg-slate-50"}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleContact(contact)}
                            className="h-4 w-4 rounded border-slate-300 accent-sky-600"
                            aria-label={`选择 ${contact.name || contact.email}`}
                          />
                          <button
                            type="button"
                            onClick={() => viewCorrespondence(contact)}
                            className="flex min-w-0 items-center gap-2.5 text-left"
                          >
                            <span
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${contact.source === "erp" ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-700"}`}
                            >
                              {(contact.name || contact.email)
                                .slice(0, 2)
                                .toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-slate-800">
                                {contact.name || contact.email}
                              </span>
                              {contact.phone && (
                                <span className="block truncate text-[11px] text-slate-400">
                                  {contact.phone}
                                </span>
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => writeToContact(contact)}
                            className="truncate text-left text-sm text-sky-700 hover:underline"
                            title={`写邮件给 ${contact.email}`}
                          >
                            {contact.email}
                          </button>
                          <div className="min-w-0">
                            <div className="truncate text-xs text-slate-600">
                              {contact.company || "未填写公司"}
                            </div>
                            <span
                              className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[10px] ${contact.source === "erp" ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-700"}`}
                            >
                              {contact.source === "erp"
                                ? "ERP 客户"
                                : "个人联系人"}
                            </span>
                          </div>
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => viewCorrespondence(contact)}
                              className="ui-tooltip flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-white"
                              title="查看往来邮件"
                              data-tooltip="查看往来邮件"
                            >
                              <MailOpen className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => writeToContact(contact)}
                              className="ui-tooltip flex h-8 w-8 items-center justify-center rounded-lg text-sky-600 hover:bg-white"
                              title="写邮件"
                              data-tooltip="写邮件"
                            >
                              <Send className="h-4 w-4" />
                            </button>
                            {contact.source === "saved" && contact.id > 0 && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => editContact(contact)}
                                  className="ui-tooltip flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-white"
                                  title="编辑联系人"
                                  data-tooltip="编辑联系人"
                                >
                                  <Pencil className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteContact(contact)}
                                  className="ui-tooltip flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50"
                                  title="删除联系人"
                                  data-tooltip="删除联系人"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <aside className="max-h-[46dvh] overflow-y-auto bg-slate-50 p-4 lg:max-h-none">
              <div className="mb-1 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-800">
                  {editingContactID ? "编辑个人联系人" : "新建个人联系人"}
                </div>
                {editingContactID && (
                  <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] text-sky-700">
                    编辑中
                  </span>
                )}
              </div>
              <p className="mb-4 text-xs leading-5 text-slate-400">
                个人联系人仅当前邮箱账号可见。ERP 客户请在业务系统中维护。
              </p>
              <div className="grid gap-3">
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">
                    姓名
                  </span>
                  <input
                    value={contactDraft.name}
                    onChange={(event) =>
                      setContactDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="客户或联系人姓名"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-400"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">
                    邮箱
                  </span>
                  <input
                    type="email"
                    value={contactDraft.email}
                    onChange={(event) =>
                      setContactDraft((current) => ({
                        ...current,
                        email: event.target.value,
                      }))
                    }
                    placeholder="name@example.com"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-400"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">
                    公司
                  </span>
                  <input
                    value={contactDraft.company}
                    onChange={(event) =>
                      setContactDraft((current) => ({
                        ...current,
                        company: event.target.value,
                      }))
                    }
                    placeholder="公司名称"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-400"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">
                    电话
                  </span>
                  <input
                    value={contactDraft.phone}
                    onChange={(event) =>
                      setContactDraft((current) => ({
                        ...current,
                        phone: event.target.value,
                      }))
                    }
                    placeholder="可选"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-400"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">
                    备注
                  </span>
                  <textarea
                    value={contactDraft.notes}
                    onChange={(event) =>
                      setContactDraft((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                    placeholder="客户偏好、沟通注意事项等"
                    className="min-h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400"
                  />
                </label>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingContactID(null);
                      setContactDraft(emptyContact);
                    }}
                    className="h-9 flex-1 rounded-lg border border-slate-200 bg-white text-sm text-slate-600"
                  >
                    {editingContactID ? "取消编辑" : "清空"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveContact()}
                    disabled={savingContact}
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-900 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {savingContact ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {editingContactID ? "保存修改" : "保存联系人"}
                  </button>
                </div>
              </div>
            </aside>
          </div>
        </ModalShell>
      )}

      {compose && (
        <div
          className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !sending)
              setCompose(null);
          }}
        >
          <div className="flex h-[96dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:h-auto sm:max-h-[94dvh] sm:rounded-lg">
            <div className="flex h-14 shrink-0 items-center justify-between bg-slate-900 px-4 text-white">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Pencil className="h-4 w-4" />
                新邮件
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setContactsOpen(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
                  title="选择联系人"
                >
                  <BookUser className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setCompose(null)}
                  disabled={sending}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
                  title="关闭写邮件"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              <datalist id="mail-contact-options">
                {contacts.map((contact) => (
                  <option
                    key={`${contact.source}-${contact.id}-${contact.email}`}
                    value={
                      contact.name
                        ? `${contact.name} <${contact.email}>`
                        : contact.email
                    }
                  >
                    {contact.company}
                  </option>
                ))}
              </datalist>
              <div className="space-y-2">
                <input
                  list="mail-contact-options"
                  value={compose.to}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? { ...current, to: event.target.value }
                        : current,
                    )
                  }
                  placeholder="收件人，可输入客户姓名搜索；多人用分号分隔"
                  className="h-10 w-full border-b border-slate-200 px-2 text-sm outline-none focus:border-sky-500"
                />
                <input
                  list="mail-contact-options"
                  value={compose.cc}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? { ...current, cc: event.target.value }
                        : current,
                    )
                  }
                  placeholder="抄送"
                  className="h-10 w-full border-b border-slate-200 px-2 text-sm outline-none focus:border-sky-500"
                />
                <input
                  list="mail-contact-options"
                  value={compose.bcc}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? { ...current, bcc: event.target.value }
                        : current,
                    )
                  }
                  placeholder="密送"
                  className="h-10 w-full border-b border-slate-200 px-2 text-sm outline-none focus:border-sky-500"
                />
                <input
                  value={compose.subject}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? { ...current, subject: event.target.value }
                        : current,
                    )
                  }
                  placeholder="主题"
                  className="h-11 w-full border-b border-slate-200 px-2 text-sm font-medium outline-none focus:border-sky-500"
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3">
                <div className="inline-flex rounded-lg border border-slate-200 p-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setCompose((current) =>
                        current ? { ...current, format: "text" } : current,
                      );
                      setComposeView("edit");
                    }}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${compose.format === "text" ? "bg-slate-900 text-white" : "text-slate-500"}`}
                  >
                    <Type className="h-3.5 w-3.5" />
                    纯文本
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCompose((current) =>
                        current
                          ? {
                              ...current,
                              format: "html",
                              htmlBody:
                                current.htmlBody ||
                                textToHTML(current.textBody),
                            }
                          : current,
                      );
                      setComposeView("edit");
                    }}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${compose.format === "html" ? "bg-slate-900 text-white" : "text-slate-500"}`}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    HTML
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setComposeView((current) =>
                      current === "edit" ? "preview" : "edit",
                    )
                  }
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs ${composeView === "preview" ? "border-sky-200 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-500"}`}
                >
                  <Eye className="h-3.5 w-3.5" />
                  {composeView === "preview" ? "返回编辑" : "预览邮件"}
                </button>
                <select
                  value={compose.priority}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? {
                            ...current,
                            priority: event.target
                              .value as ComposeState["priority"],
                          }
                        : current,
                    )
                  }
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600"
                >
                  <option value="normal">普通优先级</option>
                  <option value="high">高优先级</option>
                  <option value="low">低优先级</option>
                </select>
                <label className="inline-flex h-8 items-center gap-2 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={compose.requestReadReceipt}
                    onChange={(event) =>
                      setCompose((current) =>
                        current
                          ? {
                              ...current,
                              requestReadReceipt: event.target.checked,
                            }
                          : current,
                      )
                    }
                    className="h-3.5 w-3.5 accent-sky-600"
                  />
                  请求已读回执
                </label>
              </div>
              {composeView === "preview" ? (
                <iframe
                  title="邮件发送预览"
                  sandbox=""
                  srcDoc={iframeDocument(composePreview)}
                  className="mt-3 min-h-[48dvh] w-full rounded-lg border border-slate-200"
                />
              ) : compose.format === "html" ? (
                <textarea
                  value={compose.htmlBody}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? { ...current, htmlBody: event.target.value }
                        : current,
                    )
                  }
                  placeholder="输入 HTML 邮件正文，例如 <h2>报价单</h2>"
                  className="mt-3 min-h-[42dvh] w-full resize-y rounded-lg border border-slate-200 p-3 font-mono text-sm leading-6 outline-none focus:border-sky-400"
                />
              ) : (
                <textarea
                  value={compose.textBody}
                  onChange={(event) =>
                    setCompose((current) =>
                      current
                        ? { ...current, textBody: event.target.value }
                        : current,
                    )
                  }
                  placeholder="邮件正文"
                  className="mt-3 min-h-[42dvh] w-full resize-y rounded-lg border border-slate-200 p-3 text-sm leading-7 outline-none focus:border-sky-400"
                />
              )}
              {composeFiles.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  {composeFiles.map((file, index) => (
                    <div
                      key={`${file.name}-${index}`}
                      className="flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                    >
                      <Paperclip className="h-3.5 w-3.5 text-sky-600" />
                      <span className="max-w-48 truncate">{file.name}</span>
                      <span className="text-slate-400">
                        {formatBytes(file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setComposeFiles((current) =>
                            current.filter(
                              (_, fileIndex) => fileIndex !== index,
                            ),
                          )
                        }
                        title="移除附件"
                      >
                        <X className="h-3.5 w-3.5 text-slate-400" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {error && (
                <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </div>
              )}
            </div>
            <div className="flex min-h-14 shrink-0 items-center gap-2 border-t border-slate-200 px-3 sm:px-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                title="添加附件"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  setComposeFiles((current) => [...current, ...files]);
                  event.target.value = "";
                }}
              />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                {account.signature_html
                  ? "发送时会附加已预览的 HTML 签名"
                  : "未设置邮箱签名"}
              </span>
              <button
                type="button"
                onClick={() => void sendMessage()}
                disabled={sending}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {sending ? "发送中" : "发送"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthGuard>
  );
}

function ContextButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: typeof Mail;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick();
        window.dispatchEvent(new Event("click"));
      }}
      className={`flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-slate-50 ${danger ? "text-rose-600" : "text-slate-700"}`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function ModalShell({
  title,
  subtitle,
  onClose,
  maxWidth,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  maxWidth: string;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[96dvh] min-h-0 w-full ${maxWidth} flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:max-h-[92dvh] sm:rounded-lg`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-4 sm:px-5">
          <div>
            <h2 className="font-semibold text-slate-950">{title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function StatusMessage({
  error,
  notice,
  compact = false,
  onClose,
}: {
  error: string;
  notice: string;
  compact?: boolean;
  onClose?: () => void;
}) {
  if (!error && !notice) return null;
  return (
    <div
      className={`${compact ? "" : "mx-4 mb-4 sm:mx-6"} flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm ${error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
    >
      {error ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <CheckSquare className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{error || notice}</span>
      {onClose && (
        <button type="button" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function AccountForm({
  value,
  onChange,
  existing,
}: {
  value: MailAccountInput;
  onChange: (value: MailAccountInput) => void;
  existing: boolean;
}) {
  return (
    <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-6">
      <label>
        <span className="mb-1.5 block text-xs font-medium text-slate-600">
          邮箱地址
        </span>
        <input
          type="email"
          value={value.email_address}
          onChange={(event) =>
            onChange({ ...value, email_address: event.target.value })
          }
          placeholder="name@example.com"
          className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
        />
      </label>
      <label>
        <span className="mb-1.5 block text-xs font-medium text-slate-600">
          发件人名称
        </span>
        <input
          value={value.display_name}
          onChange={(event) =>
            onChange({ ...value, display_name: event.target.value })
          }
          placeholder="你的姓名或部门"
          className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
        />
      </label>
      <label>
        <span className="mb-1.5 block text-xs font-medium text-slate-600">
          登录用户名
        </span>
        <input
          value={value.login_username}
          onChange={(event) =>
            onChange({ ...value, login_username: event.target.value })
          }
          placeholder="默认使用完整邮箱地址"
          className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
        />
      </label>
      <label>
        <span className="mb-1.5 block text-xs font-medium text-slate-600">
          邮箱密码
        </span>
        <input
          type="password"
          value={value.password}
          onChange={(event) =>
            onChange({ ...value, password: event.target.value })
          }
          placeholder={existing ? "留空则不修改密码" : "Poste.io 邮箱密码"}
          className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-400"
        />
      </label>
      <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
        <label>
          <span className="mb-1.5 block text-xs font-medium text-slate-600">
            HTML 邮件签名
          </span>
          <textarea
            value={value.signature_html}
            onChange={(event) =>
              onChange({ ...value, signature_html: event.target.value })
            }
            placeholder="例如：&lt;strong&gt;姓名&lt;/strong&gt;&lt;br&gt;公司与联系方式"
            className="min-h-36 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm leading-6 outline-none focus:border-sky-400"
          />
        </label>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-slate-600">
            签名预览
          </span>
          <iframe
            title="HTML 签名预览"
            sandbox=""
            srcDoc={iframeDocument(
              value.signature_html ||
                '<span style="color:#94a3b8">尚未填写签名</span>',
            )}
            className="min-h-36 w-full rounded-lg border border-slate-200 bg-white"
          />
        </div>
      </div>
      <div className="rounded-lg border border-sky-100 bg-sky-50 p-3 sm:col-span-2">
        <label className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-sky-900">
              自动转发新收件
            </div>
            <div className="mt-0.5 text-xs text-sky-700">
              后台定时检查收件箱，并转发到多个提醒邮箱。
            </div>
          </div>
          <input
            type="checkbox"
            checked={value.auto_forward_enabled}
            onChange={(event) =>
              onChange({ ...value, auto_forward_enabled: event.target.checked })
            }
            className="h-4 w-4 accent-sky-600"
          />
        </label>
        {value.auto_forward_enabled && (
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label>
              <span className="mb-1 block text-xs font-medium text-sky-800">
                转发邮箱，每行一个
              </span>
              <textarea
                value={value.auto_forward_to.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...value,
                    auto_forward_to: event.target.value
                      .split(/[;,]+/)
                      .map((item) => item.trim()),
                  })
                }
                placeholder={"notify@example.com\nmanager@example.com"}
                className="min-h-24 w-full rounded-lg border border-sky-200 bg-white px-3 py-2 text-sm outline-none"
              />
            </label>
            <label className="flex items-center gap-2 self-end rounded-lg border border-sky-200 bg-white p-3 text-xs text-sky-800">
              <input
                type="checkbox"
                checked={value.forward_attachments}
                onChange={(event) =>
                  onChange({
                    ...value,
                    forward_attachments: event.target.checked,
                  })
                }
                className="h-3.5 w-3.5 accent-sky-600"
              />
              同时转发附件
            </label>
          </div>
        )}
      </div>
      <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 sm:col-span-2">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) =>
            onChange({ ...value, enabled: event.target.checked })
          }
          className="h-4 w-4 accent-sky-600"
        />
        <div>
          <div className="text-sm font-medium text-slate-800">启用此邮箱</div>
          <div className="mt-0.5 text-xs text-slate-500">
            关闭后暂停收发，但保留绑定、签名和转发设置。
          </div>
        </div>
      </label>
    </div>
  );
}
