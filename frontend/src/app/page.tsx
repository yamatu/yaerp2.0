"use client";

import {
  ArrowRight,
  ArrowUpDown,
  BarChart3,
  Bell,
  BriefcaseBusiness,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  Command,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Globe2,
  Home,
  Images,
  Info,
  Layers3,
  LayoutGrid,
  List as ListIcon,
  Lock,
  LogOut,
  Mail,
  MessageCircle,
  MessageSquare,
  PencilLine,
  Plus,
  Search,
  Settings,
  Share2,
  Shield,
  Square,
  Star,
  StarOff,
  Trash2,
  Unlock,
  Upload,
  UserRoundPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/auth/AuthGuard";
import {
  WhatsAppSendDialog,
  type WhatsAppSendResource,
} from "@/components/whatsapp/WhatsAppSendDialog";
import { ActionMenu, type ActionMenuRequest } from "@/components/workbench/ActionMenu";
import { FileIconView } from "@/components/workbench/FileIconView";
import {
  FileListView,
  type WorkbenchSortKey,
} from "@/components/workbench/FileListView";
import { ItemIcon } from "@/components/workbench/ItemIcon";
import { MoveDialog, type MoveTarget } from "@/components/workbench/MoveDialog";
import {
  PropertiesDialog,
  type PropertyRow,
} from "@/components/workbench/PropertiesDialog";
import {
  ResponsiveDialog,
  dialogDangerButton,
  dialogInput,
  dialogPrimaryButton,
  dialogSecondaryButton,
} from "@/components/workbench/ResponsiveDialog";
import {
  formatDateTime,
  formatShortDate,
  type BrowserBadge,
  type BrowserItem,
  type MenuPoint,
  type WorkbenchAction,
} from "@/components/workbench/types";
import { useBrowserInteractions } from "@/components/workbench/useBrowserInteractions";
import {
  useCoarsePointer,
  useIsMobileLayout,
} from "@/components/workbench/useMediaQuery";
import { useWorkbooks } from "@/hooks/useSheet";
import { useFileManager } from "@/hooks/useFileManager";
import {
  ensureExcelDownloadFilename,
  EXCEL_IMPORT_ACCEPT,
  EXCEL_IMPORT_FORMATS_LABEL,
  isSupportedExcelImportFile,
  uploadNewWorkbookXlsx,
} from "@/components/spreadsheet/ImportXlsxButton";
import api from "@/lib/api";
import {
  clearTokens,
  fetchCurrentUser,
  getRefreshToken,
  getStoredUser,
  isAdmin,
} from "@/lib/auth";
import { wsClient } from "@/lib/ws";
import { AI_CONTEXT_DRAG_MIME, type AIContextDragPayload } from "@/lib/dataEvents";
import type {
  AuthUser,
  Channel,
  Folder,
  FolderOption,
  FolderShareUser,
  PageData,
  TaskCenterSummary,
  User,
  Workbook,
} from "@/types";

interface WorkbookImportSource {
  filename?: string;
  attachment_id?: number | null;
}

type WorkbookViewMode = "desktop" | "list";

const WORKBOOK_DRAG_MIME = "application/x-yaerp-workbook";

interface HomeMailSummary {
  configured: boolean;
  enabled: boolean;
  address?: string;
  unread: number;
  total?: number;
  last_error?: string;
}

interface ExcelImportEntry {
  file: File;
  relativePath: string;
}

interface LegacyFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface LegacyFileSystemFileEntry extends LegacyFileSystemEntry {
  file: (
    success: (file: File) => void,
    failure?: (error: DOMException) => void,
  ) => void;
}

interface LegacyFileSystemDirectoryEntry extends LegacyFileSystemEntry {
  createReader: () => {
    readEntries: (
      success: (entries: LegacyFileSystemEntry[]) => void,
      failure?: (error: DOMException) => void,
    ) => void;
  };
}

function readDroppedFile(entry: LegacyFileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function readAllDirectoryEntries(entry: LegacyFileSystemDirectoryEntry) {
  const reader = entry.createReader();
  const entries: LegacyFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<LegacyFileSystemEntry[]>(
      (resolve, reject) => reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function collectDroppedExcelEntries(
  entry: LegacyFileSystemEntry,
  parentPath = "",
): Promise<ExcelImportEntry[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readDroppedFile(entry as LegacyFileSystemFileEntry);
    return [{ file, relativePath }];
  }
  if (!entry.isDirectory) return [];
  const children = await readAllDirectoryEntries(
    entry as LegacyFileSystemDirectoryEntry,
  );
  const nested = await Promise.all(
    children.map((child) => collectDroppedExcelEntries(child, relativePath)),
  );
  return nested.flat();
}

function ownResourceFilterStorageKey(userId: number) {
  return `yaerp:home:${userId}:show-only-own-resources`;
}

function legacyOwnWorkbookFilterStorageKey(userId: number) {
  return `yaerp:home:${userId}:show-only-own-workbooks`;
}

function workbookViewStorageKey(userId: number) {
  return `yaerp:home:${userId}:workbook-view`;
}

function getWorkbookImportSource(
  workbook: Workbook,
): WorkbookImportSource | null {
  const source = workbook.metadata?.importSource;
  if (!source || typeof source !== "object") return null;
  return source as WorkbookImportSource;
}

function hasWorkbookSourceXlsx(workbook: Workbook) {
  const attachmentId = getWorkbookImportSource(workbook)?.attachment_id;
  return typeof attachmentId === "number" && attachmentId > 0;
}

function sanitizeDownloadFilename(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned || "workbook";
}

function parseFilenameFromDisposition(
  disposition: string | null,
  fallback: string,
) {
  if (!disposition) return fallback;
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || fallback;
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function channelStorageKey(userId: number, suffix: string) {
  return `yaerp:channels:${userId}:${suffix}`;
}

function pinnedStorageKey(userId: number) {
  return `yaerp:home:${userId}:pinned`;
}

function sortStorageKey(userId: number) {
  return `yaerp:home:${userId}:workbook-sort`;
}

interface PinnedEntry {
  kind: "folder" | "workbook";
  id: number;
  name: string;
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}

type WorkbookStateAction =
  | "lock"
  | "unlock"
  | "hide"
  | "unhide"
  | "publish"
  | "unpublish";

const SORT_OPTIONS: Array<{ value: WorkbenchSortKey; label: string }> = [
  { value: "updated_at", label: "修改时间" },
  { value: "created_at", label: "创建时间" },
  { value: "name", label: "名称" },
  { value: "type", label: "类型" },
];

function readPinned(userId: number | undefined): PinnedEntry[] {
  if (!userId || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      localStorage.getItem(pinnedStorageKey(userId)) || "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PinnedEntry =>
        !!entry &&
        (entry.kind === "folder" || entry.kind === "workbook") &&
        typeof entry.id === "number" &&
        typeof entry.name === "string",
    );
  } catch {
    return [];
  }
}

function readSortPreference(userId: number | undefined): {
  by: WorkbenchSortKey;
  order: "asc" | "desc";
} {
  const fallback = { by: "updated_at" as WorkbenchSortKey, order: "desc" as const };
  if (!userId || typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(sortStorageKey(userId)) || "null");
    if (
      parsed &&
      SORT_OPTIONS.some((option) => option.value === parsed.by) &&
      (parsed.order === "asc" || parsed.order === "desc")
    )
      return parsed;
  } catch {
    // Ignore malformed preferences.
  }
  return fallback;
}

function greetingFor(date: Date) {
  const hour = date.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function folderAccessLabel(folder: Folder) {
  switch (folder.access_level) {
    case "owner":
      return "所有者";
    case "admin":
      return "管理员";
    case "edit":
      return "可写共享";
    case "view":
      return "只读共享";
    default:
      return folder.can_manage ? "可管理" : folder.can_write ? "可写" : "只读";
  }
}

function CountBadge({ value, tone = "rose" }: { value: number; tone?: "rose" | "amber" | "sky" }) {
  if (value <= 0) return null;
  const toneClass =
    tone === "amber" ? "bg-amber-500" : tone === "sky" ? "bg-sky-600" : "bg-rose-500";
  return (
    <span
      className={`absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 text-white ring-2 ring-white ${toneClass}`}
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { workbooks, refresh } = useWorkbooks();
  const {
    currentFolderId,
    contents,
    breadcrumb,
    loading: folderLoading,
    error: folderError,
    navigateTo: navigateToFolder,
    refresh: refreshFolder,
    createFolder,
    renameFolder,
  } = useFileManager();
  const isMobile = useIsMobileLayout();
  const coarsePointer = useCoarsePointer();
  const touchUi = isMobile || coarsePointer;
  const [creating, setCreating] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [folderBeingRenamed, setFolderBeingRenamed] =
    useState<Folder | null>(null);
  const [folderRenameName, setFolderRenameName] = useState("");
  const [folderRenameSaving, setFolderRenameSaving] = useState(false);
  const [folderRenameError, setFolderRenameError] = useState("");
  const [newName, setNewName] = useState("");
  const [profile, setProfile] = useState<AuthUser | null>(getStoredUser());
  const [whatsAppResource, setWhatsAppResource] =
    useState<WhatsAppSendResource | null>(null);
  const [channelNotifications, setChannelNotifications] = useState<Channel[]>(
    [],
  );
  const [taskSummary, setTaskSummary] = useState<TaskCenterSummary>({
    pending_approvals: 0,
    unread_erp_tasks: 0,
    unread_system_notifications: 0,
    unread_notifications: 0,
  });
  const [mailSummary, setMailSummary] = useState<HomeMailSummary>({
    configured: false,
    enabled: false,
    unread: 0,
  });
  const [channelNotificationOpen, setChannelNotificationOpen] = useState(false);
  const [mailNotificationOpen, setMailNotificationOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [editingWorkbook, setEditingWorkbook] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [editWorkbookName, setEditWorkbookName] = useState("");
  const workbookImportInputRef = useRef<HTMLInputElement | null>(null);
  const workbookFolderImportInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCreateRef = useRef<"workbook" | "folder" | null>(null);
  const workbookDropDepthRef = useRef(0);
  const [importingWorkbook, setImportingWorkbook] = useState(false);
  const [importingWorkbookFolder, setImportingWorkbookFolder] = useState(false);
  const [workbookDropActive, setWorkbookDropActive] = useState(false);
  const [workbookImportProgress, setWorkbookImportProgress] = useState(0);
  const [workbookFolderImportStatus, setWorkbookFolderImportStatus] =
    useState("");
  const [workbookImportError, setWorkbookImportError] = useState("");
  const [duplicatingWorkbookId, setDuplicatingWorkbookId] = useState<
    number | null
  >(null);
  const [downloadingSourceWorkbookId, setDownloadingSourceWorkbookId] =
    useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [workbookSortBy, setWorkbookSortBy] = useState<WorkbenchSortKey>(
    () => readSortPreference(getStoredUser()?.id).by,
  );
  const [workbookSortOrder, setWorkbookSortOrder] = useState<"asc" | "desc">(
    () => readSortPreference(getStoredUser()?.id).order,
  );
  const [workbookViewMode, setWorkbookViewMode] = useState<WorkbookViewMode>(
    () => {
      const user = getStoredUser();
      if (!user || typeof window === "undefined") return "desktop";
      return localStorage.getItem(workbookViewStorageKey(user.id)) === "list"
        ? "list"
        : "desktop";
    },
  );
  const [groupByOwner, setGroupByOwner] = useState(true);
  const [showOnlyOwnResources, setShowOnlyOwnResources] = useState(() => {
    const user = getStoredUser();
    if (!user || typeof window === "undefined") return false;
    const stored =
      localStorage.getItem(ownResourceFilterStorageKey(user.id)) ??
      localStorage.getItem(legacyOwnWorkbookFilterStorageKey(user.id));
    return stored === "true";
  });
  const [workbookPage, setWorkbookPage] = useState(1);
  const [assigningWorkbook, setAssigningWorkbook] = useState<Workbook | null>(
    null,
  );
  const [assignableUsers, setAssignableUsers] = useState<User[]>([]);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<number[]>([]);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentMessage, setAssignmentMessage] = useState("");
  const [movingWorkbookIds, setMovingWorkbookIds] = useState<number[]>([]);
  const [draggedWorkbookIds, setDraggedWorkbookIds] = useState<number[]>([]);
  const [workbookDropTarget, setWorkbookDropTarget] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [sharedFolders, setSharedFolders] = useState<Folder[]>([]);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  const [shareableUsers, setShareableUsers] = useState<User[]>([]);
  const [selectedShares, setSelectedShares] = useState<
    Record<number, "view" | "edit">
  >({});
  const [shareLoading, setShareLoading] = useState(false);
  const [shareSaving, setShareSaving] = useState(false);
  const [shareLoadFailed, setShareLoadFailed] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [batchWorkbookActionLoading, setBatchWorkbookActionLoading] =
    useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [menuRequest, setMenuRequest] = useState<ActionMenuRequest | null>(
    null,
  );
  const [moveRequest, setMoveRequest] = useState<{
    workbookIds: number[];
    title: string;
  } | null>(null);
  const [moveTargets, setMoveTargets] = useState<MoveTarget[]>([]);
  const [moveTargetsLoading, setMoveTargetsLoading] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveDialogError, setMoveDialogError] = useState("");
  const [propertiesItem, setPropertiesItem] = useState<BrowserItem | null>(
    null,
  );
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null,
  );
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [pinnedEntries, setPinnedEntries] = useState<PinnedEntry[]>(() =>
    readPinned(getStoredUser()?.id),
  );
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const notificationAreaRef = useRef<HTMLDivElement>(null);
  const latestChannelMessageIdsRef = useRef<Map<number, number>>(new Map());
  const channelNotificationsInitializedRef = useRef(false);
  const previousMailUnreadRef = useRef<number | null>(null);
  const mailSummaryPollingRef = useRef(false);
  const notificationAudioContextRef = useRef<AudioContext | null>(null);
  const adminMode = isAdmin(profile);
  const workbookPageSize = 30;
  const currentFolderMeta =
    currentFolderId !== null ? breadcrumb[breadcrumb.length - 1] || null : null;
  const canWriteCurrentFolder =
    currentFolderId === null || Boolean(currentFolderMeta?.can_write);
  const importBusy = importingWorkbook || importingWorkbookFolder;
  const unreadChannels = useMemo(
    () =>
      channelNotifications
        .filter((channel) => channel.unread_count > 0)
        .sort((left, right) =>
          (right.last_message_at || right.updated_at).localeCompare(
            left.last_message_at || left.updated_at,
          ),
        ),
    [channelNotifications],
  );
  const totalChannelUnread = useMemo(
    () =>
      unreadChannels.reduce((sum, channel) => sum + channel.unread_count, 0),
    [unreadChannels],
  );
  const totalTaskUnread =
    taskSummary.pending_approvals + taskSummary.unread_notifications;

  const playHomeNotificationSound = useCallback(async () => {
    if (
      !profile?.id ||
      localStorage.getItem(channelStorageKey(profile.id, "sound-enabled")) ===
        "false"
    )
      return;
    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) return;
    if (!notificationAudioContextRef.current)
      notificationAudioContextRef.current = new AudioContextClass();
    const context = notificationAudioContextRef.current;
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
    oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.setValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.1, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  }, [profile?.id]);

  const loadChannelNotifications = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const res = await api.get<Channel[]>("/channels");
      if (res.code !== 0 || !res.data) return;
      const nextIds = new Map<number, number>();
      let hasNewColleagueMessage = false;
      res.data.forEach((channel) => {
        const latestId = channel.last_message_id || 0;
        nextIds.set(channel.id, latestId);
        const previousId = latestChannelMessageIdsRef.current.get(channel.id);
        if (
          channelNotificationsInitializedRef.current &&
          previousId !== undefined &&
          latestId > previousId &&
          channel.last_message_sender_id !== profile.id &&
          channel.unread_count > 0
        ) {
          hasNewColleagueMessage = true;
        }
      });
      latestChannelMessageIdsRef.current = nextIds;
      channelNotificationsInitializedRef.current = true;
      setChannelNotifications(res.data);
      if (hasNewColleagueMessage) void playHomeNotificationSound();
    } catch {
      // Workbook operations should remain available if channel polling fails.
    }
  }, [playHomeNotificationSound, profile?.id]);

  const loadTaskSummary = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const response = await api.get<TaskCenterSummary>("/tasks/summary");
      if (response.code === 0 && response.data) setTaskSummary(response.data);
    } catch {
      // Task badge should not block workbook operations.
    }
  }, [profile?.id]);

  const loadMailSummary = useCallback(async () => {
    if (!profile?.id || mailSummaryPollingRef.current) return;
    mailSummaryPollingRef.current = true;
    try {
      const response = await api.get<HomeMailSummary>("/mail/summary");
      if (response.code === 0 && response.data) {
        const next = response.data;
        const previous = previousMailUnreadRef.current;
        previousMailUnreadRef.current = next.unread;
        setMailSummary((current) =>
          current.configured === next.configured &&
          current.enabled === next.enabled &&
          current.address === next.address &&
          current.unread === next.unread &&
          current.total === next.total &&
          current.last_error === next.last_error
            ? current
            : next,
        );
        if (previous !== null && next.unread > previous) {
          setMailNotificationOpen(true);
          setChannelNotificationOpen(false);
          void playHomeNotificationSound();
        }
      }
    } catch {
      // Mail status should not block workbook operations.
    } finally {
      mailSummaryPollingRef.current = false;
    }
  }, [playHomeNotificationSound, profile?.id]);

  const openChannelFromNotification = (channelId: number) => {
    if (profile?.id)
      localStorage.setItem(
        channelStorageKey(profile.id, "active-channel"),
        String(channelId),
      );
    router.push("/channels");
  };

  const canWriteFolder = (folder: Folder) => Boolean(folder.can_write);
  const canManageFolder = (folder: Folder) => Boolean(folder.can_manage);
  const canManageWorkbook = (workbook: Workbook) =>
    Boolean(adminMode || workbook.owner_id === profile?.id);
  const isAssignedTaskWorkbook = (workbook: Workbook) => {
    const metadata = workbook.metadata || {};
    return (
      typeof metadata.source_workbook_id !== "undefined" ||
      typeof metadata.assigned_by !== "undefined"
    );
  };
  const canDeleteWorkbook = (workbook: Workbook) => {
    if (adminMode) return true;
    const assigned = isAssignedTaskWorkbook(workbook);
    return (
      workbook.owner_id === profile?.id &&
      !assigned &&
      !workbook.is_locked &&
      !workbook.is_hidden
    );
  };

  // Fuzzy match: each char of query must appear in order within target
  const fuzzyMatch = (query: string, target: string): boolean => {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length;
  };

  const directoryWorkbooks = useMemo(
    () =>
      adminMode && showOnlyOwnResources
        ? contents.workbooks.filter(
            (workbook) => workbook.owner_id === profile?.id,
          )
        : contents.workbooks,
    [adminMode, contents.workbooks, profile?.id, showOnlyOwnResources],
  );

  const directoryFolders = useMemo(
    () =>
      adminMode && showOnlyOwnResources
        ? contents.folders.filter((folder) => folder.owner_id === profile?.id)
        : contents.folders,
    [adminMode, contents.folders, profile?.id, showOnlyOwnResources],
  );

  const filteredWorkbooks = useMemo(() => {
    if (!searchQuery.trim()) return directoryWorkbooks;
    return directoryWorkbooks.filter(
      (wb) =>
        fuzzyMatch(searchQuery, wb.name) ||
        fuzzyMatch(searchQuery, wb.description || "") ||
        fuzzyMatch(searchQuery, wb.owner_name || ""),
    );
  }, [directoryWorkbooks, searchQuery]);

  const sortedWorkbooks = useMemo(() => {
    const direction = workbookSortOrder === "asc" ? 1 : -1;
    const byName = (left: Workbook, right: Workbook) =>
      left.name.localeCompare(right.name, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });
    return [...filteredWorkbooks].sort((left, right) => {
      if (workbookSortBy === "name") return byName(left, right) * direction;
      if (workbookSortBy === "type") {
        const rank = (workbook: Workbook) =>
          hasWorkbookSourceXlsx(workbook) ? 0 : 1;
        return (rank(left) - rank(right)) * direction || byName(left, right);
      }
      const leftValue = new Date(left[workbookSortBy]).getTime();
      const rightValue = new Date(right[workbookSortBy]).getTime();
      return (leftValue - rightValue) * direction;
    });
  }, [filteredWorkbooks, workbookSortBy, workbookSortOrder]);

  const totalWorkbookPages = Math.max(
    1,
    Math.ceil(sortedWorkbooks.length / workbookPageSize),
  );
  const paginatedWorkbooks = useMemo(() => {
    const start = (workbookPage - 1) * workbookPageSize;
    return sortedWorkbooks.slice(start, start + workbookPageSize);
  }, [sortedWorkbooks, workbookPage, workbookPageSize]);

  const workbookGroups = useMemo(() => {
    if (!adminMode || !groupByOwner) {
      return [{ label: "", items: paginatedWorkbooks }];
    }

    const groups = new Map<string, Workbook[]>();
    paginatedWorkbooks.forEach((workbook) => {
      const label = workbook.owner_name || `用户 #${workbook.owner_id}`;
      const existing = groups.get(label) || [];
      existing.push(workbook);
      groups.set(label, existing);
    });

    return Array.from(groups.entries()).map(([label, items]) => ({
      label,
      items,
    }));
  }, [adminMode, groupByOwner, paginatedWorkbooks]);
  const visibleAssignedTaskWorkbooks = useMemo(
    () =>
      adminMode
        ? paginatedWorkbooks.filter((workbook) =>
            isAssignedTaskWorkbook(workbook),
          )
        : [],
    [adminMode, paginatedWorkbooks],
  );
  const visibleSharedFolders = useMemo(() => {
    if (adminMode && showOnlyOwnResources) return [];
    const existingIds = new Set(contents.folders.map((folder) => folder.id));
    return sharedFolders.filter((folder) => !existingIds.has(folder.id));
  }, [adminMode, contents.folders, sharedFolders, showOnlyOwnResources]);
  const writableWorkbookTargetFolders = useMemo(() => {
    const unique = new Map<number, Folder>();
    [...directoryFolders, ...visibleSharedFolders].forEach((folder) => {
      if (folder.can_write) unique.set(folder.id, folder);
    });
    return Array.from(unique.values());
  }, [directoryFolders, visibleSharedFolders]);

  const pinnedKeySet = useMemo(
    () => new Set(pinnedEntries.map((entry) => `${entry.kind}:${entry.id}`)),
    [pinnedEntries],
  );

  const folderEntries = useMemo(() => {
    const entries = [
      ...directoryFolders.map((folder) => ({ folder, shared: false })),
      ...(currentFolderId === null
        ? visibleSharedFolders.map((folder) => ({ folder, shared: true }))
        : []),
    ];
    const keyword = searchQuery.trim();
    const filtered = keyword
      ? entries.filter(
          ({ folder }) =>
            fuzzyMatch(keyword, folder.name) ||
            fuzzyMatch(keyword, folder.owner_name || ""),
        )
      : entries;
    const direction = workbookSortOrder === "asc" ? 1 : -1;
    return [...filtered].sort((left, right) => {
      const byName = left.folder.name.localeCompare(right.folder.name, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });
      if (workbookSortBy === "name") return byName * direction;
      if (workbookSortBy === "type") return byName;
      const leftValue = new Date(left.folder[workbookSortBy]).getTime();
      const rightValue = new Date(right.folder[workbookSortBy]).getTime();
      return (leftValue - rightValue) * direction || byName;
    });
    // fuzzyMatch is a pure helper recreated each render.
  }, [
    currentFolderId,
    directoryFolders,
    searchQuery,
    visibleSharedFolders,
    workbookSortBy,
    workbookSortOrder,
  ]);

  const groupedListMode =
    workbookViewMode === "list" && adminMode && groupByOwner;
  const displayWorkbooks = useMemo(
    () =>
      groupedListMode
        ? workbookGroups.flatMap((group) => group.items)
        : paginatedWorkbooks,
    [groupedListMode, paginatedWorkbooks, workbookGroups],
  );

  const workbookToItem = (workbook: Workbook): BrowserItem => {
    const key = `workbook:${workbook.id}`;
    const excelSource = hasWorkbookSourceXlsx(workbook);
    const badges: BrowserBadge[] = [];
    if (workbook.is_locked)
      badges.push({ label: "锁定", tone: "amber", icon: Lock });
    if (workbook.is_hidden)
      badges.push({ label: "不可见", tone: "slate", icon: EyeOff });
    if (workbook.is_public)
      badges.push({ label: "公共", tone: "emerald", icon: Globe2 });
    if (adminMode && isAssignedTaskWorkbook(workbook))
      badges.push({ label: "任务", tone: "violet", icon: ClipboardList });
    return {
      key,
      kind: "workbook",
      id: workbook.id,
      name: workbook.name,
      description: workbook.description?.trim() || undefined,
      ownerName: workbook.owner_name,
      typeLabel: excelSource ? "Excel 工作簿" : "在线工作簿",
      createdAt: workbook.created_at,
      updatedAt: workbook.updated_at,
      badges,
      pinned: pinnedKeySet.has(key),
      // Any visible workbook can be dragged to the AI chat; moving it into a
      // folder still needs manage rights (canMove).
      canDrag: true,
      canMove: canManageWorkbook(workbook),
      canDrop: false,
      excelSource,
      locked: workbook.is_locked,
      hidden: workbook.is_hidden,
      isPublic: workbook.is_public,
      busy: movingWorkbookIds.includes(workbook.id),
      dimmed: workbook.is_hidden,
      groupLabel: workbook.owner_name || `用户 #${workbook.owner_id}`,
    };
  };

  const folderToItem = (folder: Folder, shared: boolean): BrowserItem => {
    const key = `folder:${folder.id}`;
    const badges: BrowserBadge[] = [];
    if (shared)
      badges.push({
        label: folder.access_level === "edit" ? "可写共享" : "只读共享",
        tone: folder.access_level === "edit" ? "emerald" : "sky",
        icon: Share2,
      });
    else if (!folder.can_write)
      badges.push({ label: "只读", tone: "slate", icon: Lock });
    return {
      key,
      kind: "folder",
      id: folder.id,
      name: folder.name,
      ownerName: folder.owner_name,
      typeLabel: shared ? "共享文件夹" : "文件夹",
      createdAt: folder.created_at,
      updatedAt: folder.updated_at,
      badges,
      pinned: pinnedKeySet.has(key),
      canDrag: true,
      canDrop: canWriteFolder(folder),
      shared,
    };
  };

  const browserItems: BrowserItem[] = [
    ...folderEntries.map(({ folder, shared }) => folderToItem(folder, shared)),
    ...displayWorkbooks.map(workbookToItem),
  ];
  const browserItemKeys = browserItems.map((item) => item.key).join("|");

  const workbookLookup = useMemo(() => {
    const map = new Map<number, Workbook>();
    workbooks.forEach((workbook) => map.set(workbook.id, workbook));
    contents.workbooks.forEach((workbook) => map.set(workbook.id, workbook));
    return map;
  }, [contents.workbooks, workbooks]);
  const folderLookup = useMemo(() => {
    const map = new Map<number, Folder>();
    sharedFolders.forEach((folder) => map.set(folder.id, folder));
    contents.folders.forEach((folder) => map.set(folder.id, folder));
    return map;
  }, [contents.folders, sharedFolders]);

  const recentWorkbooks = useMemo(
    () =>
      [...workbooks]
        .filter(
          (workbook) =>
            !(adminMode && showOnlyOwnResources) ||
            workbook.owner_id === profile?.id,
        )
        .sort(
          (left, right) =>
            new Date(right.updated_at).getTime() -
            new Date(left.updated_at).getTime(),
        )
        .slice(0, 6),
    [adminMode, profile?.id, showOnlyOwnResources, workbooks],
  );

  // Quick actions coming from the global command palette. The request can
  // arrive before this page mounts (navigating from another route), so it is
  // also persisted in sessionStorage; both paths funnel into pendingCreateRef.
  useEffect(() => {
    try {
      const pending = window.sessionStorage.getItem(
        "yaerp:pending-create-sheet-item",
      );
      if (pending === "workbook" || pending === "folder") {
        pendingCreateRef.current = pending;
        window.sessionStorage.removeItem("yaerp:pending-create-sheet-item");
      }
    } catch {
      // Ignore storage failures.
    }

    const handleCreateRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string }>).detail;
      const kind = detail?.kind;
      if (kind === "workbook" || kind === "folder") {
        pendingCreateRef.current = kind;
      }
      try {
        window.sessionStorage.removeItem("yaerp:pending-create-sheet-item");
      } catch {
        // Ignore storage failures.
      }
    };

    window.addEventListener("yaerp:create-sheet-item", handleCreateRequest);
    return () =>
      window.removeEventListener("yaerp:create-sheet-item", handleCreateRequest);
  }, []);

  // Apply the pending create request once the folder is known to be writable.
  useEffect(() => {
    if (!canWriteCurrentFolder) return;
    const kind = pendingCreateRef.current;
    if (!kind) return;
    pendingCreateRef.current = null;
    if (kind === "workbook") setCreating(true);
    else setCreatingFolder(true);
  }, [canWriteCurrentFolder]);
  useEffect(() => {
    if (!profile?.id || !adminMode) return;
    localStorage.setItem(
      ownResourceFilterStorageKey(profile.id),
      String(showOnlyOwnResources),
    );
  }, [adminMode, profile?.id, showOnlyOwnResources]);
  useEffect(() => {
    if (!profile?.id) return;
    localStorage.setItem(
      workbookViewStorageKey(profile.id),
      workbookViewMode,
    );
  }, [profile?.id, workbookViewMode]);
  useEffect(() => {
    setWorkbookPage(1);
  }, [showOnlyOwnResources]);
  useEffect(() => {
    if (!profile?.id) return;
    localStorage.setItem(
      sortStorageKey(profile.id),
      JSON.stringify({ by: workbookSortBy, order: workbookSortOrder }),
    );
  }, [profile?.id, workbookSortBy, workbookSortOrder]);
  useEffect(() => {
    setPinnedEntries(readPinned(profile?.id));
  }, [profile?.id]);
  const persistPinned = useCallback(
    (next: PinnedEntry[]) => {
      setPinnedEntries(next);
      if (profile?.id)
        localStorage.setItem(pinnedStorageKey(profile.id), JSON.stringify(next));
    },
    [profile?.id],
  );
  // Keep pinned names in sync with renamed resources that are on screen.
  useEffect(() => {
    let changed = false;
    const next = pinnedEntries.map((entry) => {
      const source =
        entry.kind === "workbook"
          ? workbookLookup.get(entry.id)
          : folderLookup.get(entry.id);
      if (source && source.name !== entry.name) {
        changed = true;
        return { ...entry, name: source.name };
      }
      return entry;
    });
    if (changed) persistPinned(next);
  }, [folderLookup, persistPinned, pinnedEntries, workbookLookup]);
  useEffect(() => {
    setSelectedKeys([]);
    setWorkbookDropTarget(null);
  }, [currentFolderId, workbookPage, workbookViewMode]);
  useEffect(() => {
    const visible = new Set(browserItemKeys.split("|"));
    setSelectedKeys((current) => {
      const next = current.filter((key) => visible.has(key));
      return next.length === current.length ? current : next;
    });
  }, [browserItemKeys]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!channelNotificationOpen && !mailNotificationOpen) return;
    if (isMobile) return;
    const handlePointer = (event: PointerEvent) => {
      if (notificationAreaRef.current?.contains(event.target as Node)) return;
      setChannelNotificationOpen(false);
      setMailNotificationOpen(false);
    };
    window.addEventListener("pointerdown", handlePointer);
    return () => window.removeEventListener("pointerdown", handlePointer);
  }, [channelNotificationOpen, isMobile, mailNotificationOpen]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const res = await api.get<Folder[]>("/folders/shared");
        if (!active) return;
        setSharedFolders(res.code === 0 && res.data ? res.data : []);
      } catch (err) {
        console.error("Failed to load shared folders:", err);
        if (active) setSharedFolders([]);
      }
    })();

    return () => {
      active = false;
    };
  }, [currentFolderId]);

  // Suggestions: top 5 matching names shown in dropdown
  const suggestions = useMemo(() => {
    if (!searchQuery.trim() || !searchFocused) return [];
    return directoryWorkbooks
      .filter((wb) => fuzzyMatch(searchQuery, wb.name))
      .slice(0, 5);
  }, [directoryWorkbooks, searchQuery, searchFocused]);

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadProfile() {
      try {
        const user = await fetchCurrentUser();
        if (mounted && user) {
          setProfile(user);
        }
      } catch {
        // AuthGuard handles invalid sessions.
      }
    }

    loadProfile();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!profile?.id) return;
    void loadChannelNotifications();
    void loadTaskSummary();
    void loadMailSummary();
    const timer = window.setInterval(
      () => void loadChannelNotifications(),
      8000,
    );
    const taskTimer = window.setInterval(() => void loadTaskSummary(), 30000);
    const mailTimer = window.setInterval(() => void loadMailSummary(), 12000);
    const refreshMailWhenVisible = () => {
      if (document.visibilityState === "visible") void loadMailSummary();
    };
    window.addEventListener("focus", refreshMailWhenVisible);
    document.addEventListener("visibilitychange", refreshMailWhenVisible);
    wsClient.connect();
    const unsubscribe = wsClient.on(
      "task_notification",
      () => void loadTaskSummary(),
    );
    return () => {
      window.clearInterval(timer);
      window.clearInterval(taskTimer);
      window.clearInterval(mailTimer);
      window.removeEventListener("focus", refreshMailWhenVisible);
      document.removeEventListener("visibilitychange", refreshMailWhenVisible);
      unsubscribe();
    };
  }, [loadChannelNotifications, loadMailSummary, loadTaskSummary, profile?.id]);

  useEffect(() => {
    const baseTitle = "YaERP 2.0";
    const totalUnread = totalChannelUnread + totalTaskUnread + mailSummary.unread;
    document.title =
      totalUnread > 0 ? `(${totalUnread}) ${baseTitle}` : baseTitle;
    return () => {
      document.title = baseTitle;
    };
  }, [mailSummary.unread, totalChannelUnread, totalTaskUnread]);

  useEffect(
    () => () => {
      const context = notificationAudioContextRef.current;
      notificationAudioContextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    },
    [],
  );
  const handleCreateWorkbook = async () => {
    if (!canWriteCurrentFolder || createSaving) return;
    if (!newName.trim()) return;

    setCreateSaving(true);
    setCreateError("");
    try {
      const response = await api.post<Workbook>("/workbooks", {
        name: newName.trim(),
        folder_id: currentFolderId,
      });
      if (response.code !== 0) {
        setCreateError(response.message || "新建工作簿失败，请稍后重试。");
        return;
      }
      setNewName("");
      setCreating(false);
      await Promise.all([refresh(), refreshFolder()]);
    } catch (err) {
      console.error("Failed to create workbook:", err);
      setCreateError(
        err instanceof Error ? err.message : "新建工作簿失败，请稍后重试。",
      );
    } finally {
      setCreateSaving(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!canWriteCurrentFolder || createSaving) return;
    const name = newFolderName.trim();
    if (!name) return;
    setCreateSaving(true);
    setCreateError("");
    try {
      await createFolder(name);
      setNewFolderName("");
      setCreatingFolder(false);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "新建文件夹失败，请稍后重试。",
      );
    } finally {
      setCreateSaving(false);
    }
  };

  const closeCreateDialogs = () => {
    if (createSaving) return;
    setCreating(false);
    setCreatingFolder(false);
    setNewName("");
    setNewFolderName("");
    setCreateError("");
  };

  const handleImportWorkbookXlsx = async (file: File) => {
    if (!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder)
      return;

    setImportingWorkbook(true);
    setWorkbookImportProgress(0);
    setWorkbookImportError("");

    try {
      const result = await uploadNewWorkbookXlsx(file, {
        folderId: currentFolderId,
        onProgress: setWorkbookImportProgress,
      });
      await Promise.all([refresh(), refreshFolder()]);
      setWorkbookPage(1);
      if (result.first_sheet_id) {
        router.push(`/sheets/${result.workbook.id}/${result.first_sheet_id}`);
      } else {
        router.push(`/sheets/${result.workbook.id}`);
      }
    } catch (err) {
      setWorkbookImportError(
        err instanceof Error ? err.message : "Excel 导入失败，请稍后再试。",
      );
    } finally {
      setImportingWorkbook(false);
      setTimeout(() => setWorkbookImportProgress(0), 400);
      if (workbookImportInputRef.current) {
        workbookImportInputRef.current.value = "";
      }
    }
  };

  const handleImportWorkbookEntries = async (
    selectedEntries: ExcelImportEntry[],
  ) => {
    if (!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder)
      return;
    const entries = selectedEntries
      .filter((entry) => isSupportedExcelImportFile(entry.file))
      .map((entry) => {
        const relativePath = (entry.relativePath || entry.file.name).replaceAll(
          "\\",
          "/",
        );
        const parts = relativePath
          .split("/")
          .map((part) => part.trim())
          .filter(Boolean);
        return { file: entry.file, parts, directoryParts: parts.slice(0, -1) };
      });
    if (entries.length === 0) {
      setWorkbookImportError(
        `所选文件夹中没有 ${EXCEL_IMPORT_FORMATS_LABEL} 格式的工作簿。`,
      );
      if (workbookFolderImportInputRef.current)
        workbookFolderImportInputRef.current.value = "";
      return;
    }

    setImportingWorkbookFolder(true);
    setWorkbookImportProgress(0);
    setWorkbookImportError("");
    setWorkbookFolderImportStatus(`正在分析 ${entries.length} 个 Excel 工作簿`);

    try {
      const directoryPaths = Array.from(
        new Set(
          entries.flatMap((entry) =>
            entry.directoryParts.map((_, index) =>
              entry.directoryParts.slice(0, index + 1).join("/"),
            ),
          ),
        ),
      ).sort(
        (left, right) =>
          left.split("/").length - right.split("/").length ||
          left.localeCompare(right, "zh-CN"),
      );
      const folderIDs = new Map<string, number>();

      for (let index = 0; index < directoryPaths.length; index += 1) {
        const directoryPath = directoryPaths[index];
        const parts = directoryPath.split("/");
        const parentPath = parts.slice(0, -1).join("/");
        const parentID = parentPath
          ? folderIDs.get(parentPath)
          : currentFolderId;
        setWorkbookFolderImportStatus(`正在创建目录 ${directoryPath}`);
        const response = await api.post<Folder>("/folders", {
          name: parts.at(-1),
          parent_id: parentID ?? null,
        });
        if (response.code !== 0 || !response.data?.id)
          throw new Error(response.message || `创建目录 ${directoryPath} 失败`);
        folderIDs.set(directoryPath, response.data.id);
        setWorkbookImportProgress(
          Math.round(
            ((index + 1) /
              Math.max(1, directoryPaths.length + entries.length)) *
              100,
          ),
        );
      }

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const directoryPath = entry.directoryParts.join("/");
        const folderID = directoryPath
          ? folderIDs.get(directoryPath)
          : currentFolderId;
        if (directoryPath && !folderID)
          throw new Error(`找不到导入目录 ${directoryPath}`);
        setWorkbookFolderImportStatus(
          `正在导入 ${index + 1}/${entries.length}：${entry.parts.join("/")}`,
        );
        await uploadNewWorkbookXlsx(entry.file, {
          folderId: folderID ?? null,
          onProgress: (fileProgress) => {
            const completedUnits =
              directoryPaths.length + index + fileProgress / 100;
            setWorkbookImportProgress(
              Math.round(
                (completedUnits / (directoryPaths.length + entries.length)) *
                  100,
              ),
            );
          },
        });
      }

      setWorkbookImportProgress(100);
      setWorkbookFolderImportStatus(
        `已按原目录结构导入 ${entries.length} 个 Excel 工作簿`,
      );
      await Promise.all([refresh(), refreshFolder()]);
      setWorkbookPage(1);
    } catch (err) {
      setWorkbookImportError(
        err instanceof Error ? err.message : "Excel 文件夹批量导入失败。",
      );
    } finally {
      setImportingWorkbookFolder(false);
      window.setTimeout(() => {
        setWorkbookImportProgress(0);
        setWorkbookFolderImportStatus("");
      }, 1200);
      if (workbookFolderImportInputRef.current)
        workbookFolderImportInputRef.current.value = "";
      if (workbookImportInputRef.current)
        workbookImportInputRef.current.value = "";
    }
  };

  const handleImportWorkbookFolder = async (selectedFiles: FileList) => {
    await handleImportWorkbookEntries(
      Array.from(selectedFiles).map((file) => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
      })),
    );
  };

  const handleImportDroppedWorkbooks = async (
    droppedEntries: ExcelImportEntry[],
  ) => {
    if (!canWriteCurrentFolder) {
      setWorkbookImportError("当前文件夹为只读，不能上传 Excel。");
      return;
    }
    if (importingWorkbook || importingWorkbookFolder) return;

    const entries = droppedEntries.filter((entry) =>
      isSupportedExcelImportFile(entry.file),
    );
    if (entries.length === 0) {
      setWorkbookImportError(
        `请拖入 ${EXCEL_IMPORT_FORMATS_LABEL} 格式的文件。`,
      );
      return;
    }
    if (entries.length === 1 && !entries[0].relativePath.includes("/")) {
      await handleImportWorkbookXlsx(entries[0].file);
      return;
    }
    await handleImportWorkbookEntries(entries);
  };

  const handleWorkbookDragEnter = (event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    workbookDropDepthRef.current += 1;
    if (
      canWriteCurrentFolder &&
      !importingWorkbook &&
      !importingWorkbookFolder
    ) {
      setWorkbookDropActive(true);
    }
  };

  const handleWorkbookDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canWriteCurrentFolder ? "copy" : "none";
  };

  const handleWorkbookDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    workbookDropDepthRef.current = Math.max(
      0,
      workbookDropDepthRef.current - 1,
    );
    if (workbookDropDepthRef.current === 0) setWorkbookDropActive(false);
  };

  const handleWorkbookDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    workbookDropDepthRef.current = 0;
    setWorkbookDropActive(false);
    const fileEntries = Array.from(event.dataTransfer.items || [])
      .map(
        (item) =>
          (
            item as unknown as {
              webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
            }
          ).webkitGetAsEntry?.() || null,
      )
      .filter((entry): entry is LegacyFileSystemEntry => entry !== null);
    const fallbackFiles = Array.from(event.dataTransfer.files || []);
    void (async () => {
      try {
        const nested =
          fileEntries.length > 0
            ? (
                await Promise.all(
                  fileEntries.map((entry) => collectDroppedExcelEntries(entry)),
                )
              ).flat()
            : fallbackFiles.map((file) => ({ file, relativePath: file.name }));
        await handleImportDroppedWorkbooks(nested);
      } catch (err) {
        setWorkbookImportError(
          err instanceof Error ? err.message : "读取拖入的 Excel 目录失败。",
        );
      }
    })();
  };

  const downloadWorkbookFile = async (workbook: Workbook) => {
    const source = getWorkbookImportSource(workbook);
    const hasSource = hasWorkbookSourceXlsx(workbook);
    const fallbackBase = sanitizeDownloadFilename(
      source?.filename || workbook.name || "workbook",
    );
    const fallbackFilename = ensureExcelDownloadFilename(fallbackBase);
    const response = await api.download(
      hasSource
        ? `/workbooks/${workbook.id}/source/xlsx`
        : `/workbooks/${workbook.id}/export?filename=${encodeURIComponent(fallbackFilename)}`,
    );
    if (!response.ok) {
      let message = "下载 Excel 失败，请稍后再试。";
      try {
        const data = (await response.json()) as { message?: string };
        if (data?.message) {
          message = data.message;
        }
      } catch {
        // Ignore JSON parse errors for binary responses.
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const filename = parseFilenameFromDisposition(
      response.headers.get("Content-Disposition"),
      fallbackFilename,
    );
    triggerBrowserDownload(blob, filename);
  };

  const handleDownloadWorkbooks = async (targets: Workbook[]) => {
    if (downloadingSourceWorkbookId !== null || targets.length === 0) return;
    setWorkbookImportError("");
    try {
      for (const workbook of targets) {
        setDownloadingSourceWorkbookId(workbook.id);
        await downloadWorkbookFile(workbook);
      }
      if (targets.length > 1) setNotice(`已下载 ${targets.length} 个工作簿`);
    } catch (err) {
      setWorkbookImportError(
        err instanceof Error ? err.message : "下载 Excel 失败，请稍后再试。",
      );
    } finally {
      setDownloadingSourceWorkbookId(null);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.post("/auth/logout", { refresh_token: getRefreshToken() });
    } catch {
      // Ignore logout API failures and clear local state anyway.
    } finally {
      clearTokens();
      router.push("/login");
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    setWorkbookPage(1);
  }, [searchQuery, workbookSortBy, workbookSortOrder, groupByOwner]);

  useEffect(() => {
    if (workbookPage > totalWorkbookPages) {
      setWorkbookPage(totalWorkbookPages);
    }
  }, [workbookPage, totalWorkbookPages]);
  useEffect(() => {
    if (!sharingFolder) return;

    let active = true;
    setShareLoading(true);
    setShareLoadFailed(false);
    setShareMessage("");
    (async () => {
      try {
        const [usersRes, sharesRes] = await Promise.all([
          api.get<User[]>(`/folders/${sharingFolder.id}/shareable-users`),
          api.get<FolderShareUser[]>(`/folders/${sharingFolder.id}/shares`),
        ]);

        if (!active) return;

        setShareableUsers(
          usersRes.code === 0 && usersRes.data ? usersRes.data : [],
        );
        setSelectedShares(
          sharesRes.code === 0 && sharesRes.data
            ? sharesRes.data.reduce<Record<number, "view" | "edit">>(
                (acc, user) => {
                  acc[user.id] = user.access_level;
                  return acc;
                },
                {},
              )
            : {},
        );
        setShareLoadFailed(false);
      } catch (err) {
        console.error("Failed to load folder shares:", err);
        if (active) {
          setShareLoadFailed(true);
          setShareMessage("加载共享用户失败，请稍后重试。");
        }
      } finally {
        if (active) setShareLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [sharingFolder]);

  useEffect(() => {
    if (!assigningWorkbook || !adminMode) return;

    let active = true;
    (async () => {
      try {
        const res = await api.get<PageData<User>>("/users?page=1&size=200");
        if (!active || res.code !== 0 || !res.data) return;
        const users = res.data.list.filter((user) => {
          const isAdminUser = user.roles?.some((role) => role.code === "admin");
          return user.status === 1 && !isAdminUser;
        });
        setAssignableUsers(users);
      } catch (err) {
        console.error("Failed to load assignable users:", err);
      }
    })();

    return () => {
      active = false;
    };
  }, [adminMode, assigningWorkbook]);

  const refreshAll = () => Promise.all([refresh(), refreshFolder()]);

  const handleDuplicateWorkbook = async (workbook: Workbook) => {
    if (!canManageWorkbook(workbook) || duplicatingWorkbookId !== null) return;

    setDuplicatingWorkbookId(workbook.id);
    setWorkbookImportError("");
    try {
      const res = await api.post<Workbook>(
        `/workbooks/${workbook.id}/duplicate`,
      );
      if (res.code !== 0 || !res.data) {
        setWorkbookImportError(res.message || "复制工作簿失败，请稍后再试。");
        return;
      }
      setWorkbookPage(1);
      await refreshAll();
      setNotice(`已复制「${workbook.name}」`);
    } catch (err) {
      console.error("Failed to duplicate workbook:", err);
      setWorkbookImportError(
        err instanceof Error ? err.message : "复制工作簿失败，请稍后再试。",
      );
    } finally {
      setDuplicatingWorkbookId(null);
    }
  };

  const handleUpdateWorkbookState = async (
    workbookId: number,
    action: WorkbookStateAction,
  ) => {
    if (
      action === "publish" &&
      !window.confirm(
        "设为公共表后，所有员工都可以查看、编辑和导出该工作簿。\n数据遮罩、隐藏公式和保护区域仍然生效。确定继续吗？",
      )
    )
      return;
    if (
      action === "unpublish" &&
      !window.confirm("取消公共表后，只有被单独授权的成员还能访问。确定继续吗？")
    )
      return;
    setActionError("");
    try {
      const res = await api.put(`/workbooks/${workbookId}/state`, { action });
      if (res.code !== 0) {
        setActionError(res.message || "更新工作簿状态失败。");
        return;
      }
      await refreshAll();
    } catch (err) {
      console.error("Failed to update workbook state:", err);
      setActionError(
        err instanceof Error ? err.message : "更新工作簿状态失败。",
      );
    }
  };

  const handleBatchUpdateWorkbookState = async (
    workbookIds: number[],
    action: "lock" | "unlock" | "hide" | "unhide",
  ) => {
    if (workbookIds.length === 0) return;

    setBatchWorkbookActionLoading(true);
    setActionError("");
    try {
      const res = await api.put("/workbooks/state/batch", {
        workbook_ids: workbookIds,
        action,
      });
      if (res.code !== 0) {
        setActionError(res.message || "批量更新工作簿状态失败。");
        return;
      }
      await refreshAll();
      setNotice(`已更新 ${workbookIds.length} 个工作簿`);
      if (action === "hide") setSelectedKeys([]);
    } catch (err) {
      console.error("Failed to batch update workbook state:", err);
      setActionError(
        err instanceof Error ? err.message : "批量更新工作簿状态失败。",
      );
    } finally {
      setBatchWorkbookActionLoading(false);
    }
  };

  const handleRenameWorkbook = async () => {
    if (!editingWorkbook || !editWorkbookName.trim()) return;
    try {
      await api.put(`/workbooks/${editingWorkbook.id}`, {
        name: editWorkbookName.trim(),
      });
      setEditingWorkbook(null);
      await refreshAll();
    } catch (err) {
      console.error("Failed to rename workbook:", err);
    }
  };

  const moveWorkbooks = async (
    workbookIds: number[],
    targetFolderId: number | null,
  ) => {
    const ids = workbookIds.filter((id) => {
      const workbook = workbookLookup.get(id);
      return !workbook || (workbook.folder_id ?? null) !== targetFolderId;
    });
    setDraggedWorkbookIds([]);
    setWorkbookDropTarget(null);
    if (ids.length === 0 || targetFolderId === currentFolderId) return true;
    setMovingWorkbookIds(ids);
    setActionError("");
    const failures: string[] = [];
    try {
      for (const id of ids) {
        try {
          const response = await api.put(`/workbooks/${id}/move`, {
            folder_id: targetFolderId,
          });
          if (response.code !== 0)
            failures.push(response.message || "移动工作簿失败");
        } catch (err) {
          failures.push(err instanceof Error ? err.message : "移动工作簿失败");
        }
      }
      await refreshAll();
    } finally {
      setMovingWorkbookIds([]);
    }
    if (failures.length > 0) {
      setActionError(
        failures.length === ids.length
          ? failures[0]
          : `${ids.length - failures.length} 个已移动，${failures.length} 个失败：${failures[0]}`,
      );
      return false;
    }
    const target =
      targetFolderId === null
        ? "根目录"
        : folderLookup.get(targetFolderId)?.name ||
          breadcrumb.find((folder) => folder.id === targetFolderId)?.name ||
          moveTargets.find((option) => option.id === targetFolderId)?.name ||
          "目标文件夹";
    setNotice(`已将 ${ids.length} 个工作簿移动到「${target}」`);
    setSelectedKeys([]);
    return true;
  };

  const openMoveDialog = (workbookIds: number[], title: string) => {
    if (workbookIds.length === 0) return;
    setMoveRequest({ workbookIds, title });
    setMoveDialogError("");
    setMoveTargetsLoading(true);
    const fallback = (): MoveTarget[] => {
      const map = new Map<number, MoveTarget>();
      [...breadcrumb, ...writableWorkbookTargetFolders].forEach((folder) => {
        if (folder.can_write !== false)
          map.set(folder.id, { id: folder.id, name: folder.name, path: folder.name });
      });
      return Array.from(map.values());
    };
    void (async () => {
      let targets: MoveTarget[] = [];
      try {
        const response = await api.get<FolderOption[]>("/folders/options");
        targets =
          response.code === 0 && response.data
            ? response.data
                .filter((option) => option.can_write)
                .map((option) => ({
                  id: option.id,
                  name: option.name,
                  path: option.path,
                }))
                .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))
            : fallback();
      } catch {
        targets = fallback();
      }
      if (targets.length === 0) targets = fallback();
      setMoveTargets([{ id: null, name: "根目录", path: "" }, ...targets]);
      setMoveTargetsLoading(false);
    })();
  };

  const confirmMove = async (targetFolderId: number | null) => {
    if (!moveRequest) return;
    setMoveBusy(true);
    setMoveDialogError("");
    const ok = await moveWorkbooks(moveRequest.workbookIds, targetFolderId);
    setMoveBusy(false);
    if (ok) setMoveRequest(null);
    else setMoveDialogError("部分工作簿移动失败，详见页面提示。");
  };

  const hasInternalWorkbookDrag = (dataTransfer: DataTransfer) =>
    draggedWorkbookIds.length > 0 ||
    Array.from(dataTransfer.types || []).includes(WORKBOOK_DRAG_MIME);

  const readDraggedWorkbookIds = (dataTransfer: DataTransfer) => {
    const raw = dataTransfer.getData(WORKBOOK_DRAG_MIME);
    const parsed = raw
      .split(",")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    return parsed.length > 0 ? parsed : draggedWorkbookIds;
  };

  const handleItemDragStart = (
    item: BrowserItem,
    event: React.DragEvent<HTMLElement>,
  ) => {
    if (item.kind === "folder") {
      const payload: AIContextDragPayload = { folder: { id: item.id, name: item.name } };
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(AI_CONTEXT_DRAG_MIME, JSON.stringify(payload));
      setDraggedWorkbookIds([]);
      return;
    }
    const draggedItems = selectedKeys.includes(item.key)
      ? browserItems.filter(
          (entry) => entry.kind === "workbook" && selectedKeys.includes(entry.key),
        )
      : [item];
    const payload: AIContextDragPayload = {
      workbooks: draggedItems.map((entry) => ({ id: entry.id, name: entry.name })),
    };
    event.dataTransfer.setData(AI_CONTEXT_DRAG_MIME, JSON.stringify(payload));
    const ids = draggedItems.filter((entry) => entry.canMove).map((entry) => entry.id);
    event.dataTransfer.effectAllowed = ids.length > 0 ? "copyMove" : "copy";
    if (ids.length > 0) event.dataTransfer.setData(WORKBOOK_DRAG_MIME, ids.join(","));
    if (draggedItems.length > 1) {
      const ghost = document.createElement("div");
      ghost.textContent = `${draggedItems.length} 个工作簿`;
      ghost.style.cssText =
        "position:fixed;top:-200px;left:-200px;padding:6px 12px;border-radius:8px;background:#0f172a;color:#fff;font:600 12px system-ui,sans-serif;";
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 12, 12);
      window.setTimeout(() => ghost.remove(), 0);
    }
    setDraggedWorkbookIds(ids);
    setActionError("");
  };

  const handleInternalWorkbookDragEnd = () => {
    setDraggedWorkbookIds([]);
    setWorkbookDropTarget(null);
  };

  const handleWorkbookTargetDragOver = (
    event: React.DragEvent<HTMLElement>,
    targetKey: string,
    canWrite: boolean,
  ) => {
    if (!canWrite || !hasInternalWorkbookDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setWorkbookDropTarget(targetKey);
  };

  const handleWorkbookTargetDragLeave = (
    event: React.DragEvent<HTMLElement>,
    targetKey: string,
  ) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setWorkbookDropTarget((current) =>
      current === targetKey ? null : current,
    );
  };

  const handleWorkbookTargetDrop = (
    event: React.DragEvent<HTMLElement>,
    targetFolderId: number | null,
    canWrite: boolean,
  ) => {
    if (!hasInternalWorkbookDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = readDraggedWorkbookIds(event.dataTransfer);
    setDraggedWorkbookIds([]);
    setWorkbookDropTarget(null);
    if (canWrite && ids.length > 0) {
      void moveWorkbooks(ids, targetFolderId);
    }
  };

  const isPinned = (kind: "folder" | "workbook", id: number) =>
    pinnedKeySet.has(`${kind}:${id}`);

  const togglePinned = (entries: PinnedEntry[]) => {
    if (entries.length === 0) return;
    const allPinned = entries.every((entry) => isPinned(entry.kind, entry.id));
    if (allPinned) {
      const remove = new Set(entries.map((entry) => `${entry.kind}:${entry.id}`));
      persistPinned(
        pinnedEntries.filter((entry) => !remove.has(`${entry.kind}:${entry.id}`)),
      );
      setNotice(entries.length > 1 ? `已取消收藏 ${entries.length} 项` : "已取消收藏");
    } else {
      const additions = entries.filter((entry) => !isPinned(entry.kind, entry.id));
      persistPinned([...additions, ...pinnedEntries].slice(0, 30));
      setNotice(
        entries.length > 1 ? `已收藏 ${additions.length} 项` : "已收藏到快速访问",
      );
    }
  };

  const itemToPinned = (item: BrowserItem): PinnedEntry => ({
    kind: item.kind,
    id: item.id,
    name: item.name,
  });

  const requestDelete = (items: BrowserItem[]) => {
    const deletable = items.filter((item) => {
      if (item.kind === "folder") {
        const folder = folderLookup.get(item.id);
        return Boolean(folder && canManageFolder(folder));
      }
      const workbook = workbookLookup.get(item.id);
      return Boolean(
        workbook && canManageWorkbook(workbook) && canDeleteWorkbook(workbook),
      );
    });
    if (deletable.length === 0) {
      setActionError(
        items.length > 1 ? "所选项目都没有删除权限。" : "没有删除此项目的权限。",
      );
      return;
    }
    const skipped = items.length - deletable.length;
    const hasFolder = deletable.some((item) => item.kind === "folder");
    setConfirmRequest({
      title:
        deletable.length === 1
          ? `将「${deletable[0].name}」移入回收站？`
          : `将 ${deletable.length} 项移入回收站？`,
      message: `${
        hasFolder
          ? "文件夹的目录结构和其中的工作簿会一并移入回收站，"
          : ""
      }保留 30 天，可在回收站中还原。${
        skipped > 0 ? `另有 ${skipped} 项没有删除权限，将被跳过。` : ""
      }`,
      confirmLabel: "移入回收站",
      danger: true,
      onConfirm: async () => {
        const failures: string[] = [];
        for (const item of deletable) {
          try {
            const response = await api.delete(
              item.kind === "folder"
                ? `/folders/${item.id}`
                : `/workbooks/${item.id}`,
            );
            if (response.code !== 0)
              failures.push(response.message || `删除「${item.name}」失败`);
          } catch (err) {
            failures.push(
              err instanceof Error ? err.message : `删除「${item.name}」失败`,
            );
          }
        }
        await refreshAll();
        setSelectedKeys([]);
        const removed = new Set(deletable.map((item) => `${item.kind}:${item.id}`));
        if (pinnedEntries.some((entry) => removed.has(`${entry.kind}:${entry.id}`)))
          persistPinned(
            pinnedEntries.filter((entry) => !removed.has(`${entry.kind}:${entry.id}`)),
          );
        if (failures.length > 0) setActionError(failures[0]);
        else setNotice(`已将 ${deletable.length} 项移入回收站`);
      },
    });
  };

  const startRename = (item: BrowserItem) => {
    if (item.kind === "folder") {
      const folder = folderLookup.get(item.id);
      if (!folder || !canManageFolder(folder)) return;
      setFolderBeingRenamed(folder);
      setFolderRenameName(folder.name);
      setFolderRenameError("");
      return;
    }
    const workbook = workbookLookup.get(item.id);
    if (!workbook || !canManageWorkbook(workbook)) return;
    setEditingWorkbook({ id: workbook.id, name: workbook.name });
    setEditWorkbookName(workbook.name);
  };

  const openFolderShare = (folder: Folder) => {
    setSharingFolder(folder);
    setSelectedShares({});
    setShareMessage("");
  };

  const openAssign = (workbook: Workbook) => {
    setAssigningWorkbook(workbook);
    setSelectedAssigneeIds([]);
    setAssignmentMessage("");
  };

  const openItem = (item: BrowserItem) => {
    if (item.kind === "folder") {
      setSearchQuery("");
      void navigateToFolder(item.id);
    } else {
      router.push(`/sheets/${item.id}`);
    }
  };

  const closeFolderRenameDialog = () => {
    if (folderRenameSaving) return;
    setFolderBeingRenamed(null);
    setFolderRenameName("");
    setFolderRenameError("");
  };

  const handleRenameFolder = async () => {
    if (!folderBeingRenamed || folderRenameSaving) return;

    const name = folderRenameName.trim();
    if (!name) {
      setFolderRenameError("请输入文件夹名称。");
      return;
    }
    if ([...name].length > 256) {
      setFolderRenameError("文件夹名称不能超过 256 个字符。");
      return;
    }
    if (name === folderBeingRenamed.name) {
      closeFolderRenameDialog();
      return;
    }

    setFolderRenameSaving(true);
    setFolderRenameError("");
    try {
      await renameFolder(folderBeingRenamed.id, name);
      setFolderBeingRenamed(null);
      setFolderRenameName("");
    } catch (err) {
      setFolderRenameError(
        err instanceof Error ? err.message : "重命名文件夹失败，请稍后重试。",
      );
    } finally {
      setFolderRenameSaving(false);
    }
  };

  const handleAssignWorkbook = async () => {
    if (!assigningWorkbook || selectedAssigneeIds.length === 0) return;

    setAssignmentLoading(true);
    setAssignmentMessage("");

    try {
      const res = await api.post(`/workbooks/${assigningWorkbook.id}/assign`, {
        user_ids: selectedAssigneeIds,
      });

      if (res.code !== 0) {
        setAssignmentMessage(res.message || "发放任务失败，请稍后重试。");
        return;
      }

      setAssignmentMessage(
        `已向 ${selectedAssigneeIds.length} 位员工发放任务工作簿。`,
      );
      setSelectedAssigneeIds([]);
      await refresh();
    } catch (err) {
      console.error("Failed to assign workbook:", err);
      setAssignmentMessage("发放任务失败，请稍后重试。");
    } finally {
      setAssignmentLoading(false);
    }
  };

  const handleSaveFolderShares = async () => {
    if (!sharingFolder || shareLoading || shareLoadFailed) return;

    setShareSaving(true);
    setShareMessage("");

    try {
      const res = await api.put(`/folders/${sharingFolder.id}/shares`, {
        shares: Object.entries(selectedShares).map(([userId, accessLevel]) => ({
          user_id: Number(userId),
          access_level: accessLevel,
        })),
      });

      if (res.code !== 0) {
        setShareMessage(res.message || "保存共享设置失败，请稍后重试。");
        return;
      }

      setShareMessage("共享设置已更新。");
      await Promise.all([
        refreshFolder(),
        api.get<Folder[]>("/folders/shared").then((res) => {
          setSharedFolders(res.code === 0 && res.data ? res.data : []);
        }),
      ]);
    } catch (err) {
      console.error("Failed to save folder shares:", err);
      setShareMessage("保存共享设置失败，请稍后重试。");
    } finally {
      setShareSaving(false);
    }
  };
  const enterSelectMode = (keys: string[]) => {
    setSelectMode(true);
    setSelectedKeys(keys);
  };

  const buildWorkbookActions = (
    workbook: Workbook,
    item: BrowserItem,
  ): WorkbenchAction[] => {
    const manage = canManageWorkbook(workbook);
    const pinned = isPinned("workbook", workbook.id);
    const hasSource = hasWorkbookSourceXlsx(workbook);
    const actions: Array<WorkbenchAction | false> = [
      {
        key: "open",
        label: "打开",
        icon: ArrowRight,
        shortcut: "Enter",
        onSelect: () => router.push(`/sheets/${workbook.id}`),
      },
      manage && {
        key: "rename",
        label: "重命名",
        icon: PencilLine,
        shortcut: "F2",
        onSelect: () => startRename(item),
      },
      manage && {
        key: "move",
        label: "移动到…",
        icon: FolderInput,
        onSelect: () => openMoveDialog([workbook.id], `移动「${workbook.name}」`),
      },
      manage && {
        key: "duplicate",
        label: duplicatingWorkbookId === workbook.id ? "正在复制…" : "复制一份",
        icon: Copy,
        disabled: duplicatingWorkbookId !== null,
        onSelect: () => void handleDuplicateWorkbook(workbook),
      },
      {
        key: "download",
        label: hasSource ? "下载原始 Excel" : "导出 Excel",
        icon: Download,
        disabled: downloadingSourceWorkbookId !== null,
        onSelect: () => void handleDownloadWorkbooks([workbook]),
      },
      {
        key: "whatsapp",
        label: "发送到 WhatsApp",
        icon: MessageCircle,
        onSelect: () =>
          setWhatsAppResource({
            workbookId: workbook.id,
            title: workbook.name,
            defaultContent: `工作簿：${workbook.name}`,
          }),
      },
      {
        key: "pin",
        label: pinned ? "取消收藏" : "收藏到快速访问",
        icon: pinned ? StarOff : Star,
        separatorBefore: true,
        onSelect: () => togglePinned([itemToPinned(item)]),
      },
      manage && {
        key: "public",
        label: workbook.is_public ? "取消公共访问" : "设为公共工作簿",
        icon: Globe2,
        onSelect: () =>
          void handleUpdateWorkbookState(
            workbook.id,
            workbook.is_public ? "unpublish" : "publish",
          ),
      },
      adminMode && {
        key: "lock",
        label: workbook.is_locked ? "解除锁定" : "锁定工作簿",
        icon: workbook.is_locked ? Unlock : Lock,
        onSelect: () =>
          void handleUpdateWorkbookState(
            workbook.id,
            workbook.is_locked ? "unlock" : "lock",
          ),
      },
      adminMode && {
        key: "hide",
        label: workbook.is_hidden ? "恢复可见" : "设为不可见",
        icon: workbook.is_hidden ? Eye : EyeOff,
        onSelect: () =>
          void handleUpdateWorkbookState(
            workbook.id,
            workbook.is_hidden ? "unhide" : "hide",
          ),
      },
      adminMode && {
        key: "assign",
        label: "发放任务",
        icon: UserRoundPlus,
        onSelect: () => openAssign(workbook),
      },
      touchUi && {
        key: "select",
        label: "多选",
        icon: CheckSquare,
        separatorBefore: true,
        onSelect: () => enterSelectMode([item.key]),
      },
      {
        key: "properties",
        label: "属性",
        icon: Info,
        separatorBefore: !touchUi,
        onSelect: () => setPropertiesItem(item),
      },
      manage &&
        canDeleteWorkbook(workbook) && {
          key: "delete",
          label: "移入回收站",
          icon: Trash2,
          danger: true,
          shortcut: "Del",
          separatorBefore: true,
          onSelect: () => requestDelete([item]),
        },
    ];
    return actions.filter(Boolean) as WorkbenchAction[];
  };

  const buildFolderActions = (
    folder: Folder,
    item: BrowserItem,
  ): WorkbenchAction[] => {
    const manage = canManageFolder(folder);
    const pinned = isPinned("folder", folder.id);
    const actions: Array<WorkbenchAction | false> = [
      {
        key: "open",
        label: "打开",
        icon: FolderOpen,
        shortcut: "Enter",
        onSelect: () => openItem(item),
      },
      manage && {
        key: "rename",
        label: "重命名",
        icon: PencilLine,
        shortcut: "F2",
        onSelect: () => startRename(item),
      },
      manage && {
        key: "share",
        label: "共享与权限",
        icon: Share2,
        onSelect: () => openFolderShare(folder),
      },
      {
        key: "pin",
        label: pinned ? "取消收藏" : "收藏到快速访问",
        icon: pinned ? StarOff : Star,
        separatorBefore: true,
        onSelect: () => togglePinned([itemToPinned(item)]),
      },
      touchUi && {
        key: "select",
        label: "多选",
        icon: CheckSquare,
        onSelect: () => enterSelectMode([item.key]),
      },
      {
        key: "properties",
        label: "属性",
        icon: Info,
        onSelect: () => setPropertiesItem(item),
      },
      manage && {
        key: "delete",
        label: "移入回收站",
        icon: Trash2,
        danger: true,
        shortcut: "Del",
        separatorBefore: true,
        onSelect: () => requestDelete([item]),
      },
    ];
    return actions.filter(Boolean) as WorkbenchAction[];
  };

  const selectedItems = browserItems.filter((item) =>
    selectedKeys.includes(item.key),
  );
  const selectedWorkbooks = selectedItems
    .filter((item) => item.kind === "workbook")
    .map((item) => workbookLookup.get(item.id))
    .filter((workbook): workbook is Workbook => Boolean(workbook));
  const movableSelectedIds = selectedWorkbooks
    .filter((workbook) => canManageWorkbook(workbook))
    .map((workbook) => workbook.id);

  const buildBatchActions = (items: BrowserItem[]): WorkbenchAction[] => {
    const workbooksInSelection = items
      .filter((item) => item.kind === "workbook")
      .map((item) => workbookLookup.get(item.id))
      .filter((workbook): workbook is Workbook => Boolean(workbook));
    const movable = workbooksInSelection.filter((workbook) =>
      canManageWorkbook(workbook),
    );
    const ids = workbooksInSelection.map((workbook) => workbook.id);
    const allPinned = items.every((item) => isPinned(item.kind, item.id));
    const actions: Array<WorkbenchAction | false> = [
      movable.length > 0 && {
        key: "move",
        label: `移动 ${movable.length} 个工作簿…`,
        icon: FolderInput,
        onSelect: () =>
          openMoveDialog(
            movable.map((workbook) => workbook.id),
            `移动 ${movable.length} 个工作簿`,
          ),
      },
      workbooksInSelection.length > 0 && {
        key: "download",
        label: `下载 ${workbooksInSelection.length} 个工作簿`,
        icon: Download,
        disabled: downloadingSourceWorkbookId !== null,
        onSelect: () => void handleDownloadWorkbooks(workbooksInSelection),
      },
      {
        key: "pin",
        label: allPinned ? "取消收藏" : "收藏所选",
        icon: allPinned ? StarOff : Star,
        onSelect: () => togglePinned(items.map(itemToPinned)),
      },
      adminMode &&
        ids.length > 0 && {
          key: "lock",
          label: "批量锁定",
          icon: Lock,
          separatorBefore: true,
          disabled: batchWorkbookActionLoading,
          onSelect: () => void handleBatchUpdateWorkbookState(ids, "lock"),
        },
      adminMode &&
        ids.length > 0 && {
          key: "unlock",
          label: "批量解除锁定",
          icon: Unlock,
          disabled: batchWorkbookActionLoading,
          onSelect: () => void handleBatchUpdateWorkbookState(ids, "unlock"),
        },
      adminMode &&
        ids.length > 0 && {
          key: "hide",
          label: "批量设为不可见",
          icon: EyeOff,
          disabled: batchWorkbookActionLoading,
          onSelect: () => void handleBatchUpdateWorkbookState(ids, "hide"),
        },
      adminMode &&
        ids.length > 0 && {
          key: "unhide",
          label: "批量恢复可见",
          icon: Eye,
          disabled: batchWorkbookActionLoading,
          onSelect: () => void handleBatchUpdateWorkbookState(ids, "unhide"),
        },
      {
        key: "clear",
        label: "取消选择",
        icon: X,
        separatorBefore: true,
        onSelect: () => {
          setSelectedKeys([]);
          setSelectMode(false);
        },
      },
      {
        key: "delete",
        label: `移入回收站（${items.length}）`,
        icon: Trash2,
        danger: true,
        shortcut: "Del",
        onSelect: () => requestDelete(items),
      },
    ];
    return actions.filter(Boolean) as WorkbenchAction[];
  };

  const handleItemMenu = (
    item: BrowserItem,
    point: MenuPoint,
    selection: string[],
    options?: { alignEnd?: boolean },
  ) => {
    if (selection.length > 1 && selection.includes(item.key)) {
      const items = browserItems.filter((entry) => selection.includes(entry.key));
      setMenuRequest({
        point,
        alignEnd: options?.alignEnd,
        title: `已选择 ${items.length} 项`,
        subtitle: `${items.filter((entry) => entry.kind === "folder").length} 个文件夹 · ${items.filter((entry) => entry.kind === "workbook").length} 个工作簿`,
        icon: <CheckSquare className="h-5 w-5 text-sky-600" />,
        actions: buildBatchActions(items),
      });
      return;
    }
    const actions =
      item.kind === "folder"
        ? (() => {
            const folder = folderLookup.get(item.id);
            return folder ? buildFolderActions(folder, item) : [];
          })()
        : (() => {
            const workbook = workbookLookup.get(item.id);
            return workbook ? buildWorkbookActions(workbook, item) : [];
          })();
    if (actions.length === 0) return;
    setMenuRequest({
      point,
      alignEnd: options?.alignEnd,
      title: item.name,
      subtitle: [item.typeLabel, item.ownerName, formatShortDate(item.updatedAt)]
        .filter(Boolean)
        .join(" · "),
      icon: <ItemIcon item={item} size="sm" />,
      actions,
    });
  };

  const closeMenu = useCallback(() => {
    setMenuRequest(null);
    if (touchUi && !selectMode) setSelectedKeys([]);
  }, [selectMode, touchUi]);

  const openMenuAt = (
    anchor: HTMLElement,
    request: Omit<ActionMenuRequest, "point" | "alignEnd">,
  ) => {
    const rect = anchor.getBoundingClientRect();
    setMenuRequest({
      ...request,
      point: { x: rect.right, y: rect.bottom + 6 },
      alignEnd: true,
    });
  };

  const createActions: WorkbenchAction[] = [
    {
      key: "workbook",
      label: "新建工作簿",
      icon: Plus,
      disabled: !canWriteCurrentFolder || importBusy,
      onSelect: () => setCreating(true),
    },
    {
      key: "folder",
      label: "新建文件夹",
      icon: FolderPlus,
      disabled: !canWriteCurrentFolder,
      onSelect: () => setCreatingFolder(true),
    },
    {
      key: "upload",
      label: "上传 Excel",
      icon: Upload,
      separatorBefore: true,
      disabled: !canWriteCurrentFolder || importBusy,
      onSelect: () => workbookImportInputRef.current?.click(),
    },
    {
      key: "upload-folder",
      label: "上传 Excel 文件夹",
      icon: FolderUp,
      disabled: !canWriteCurrentFolder || importBusy,
      onSelect: () => workbookFolderImportInputRef.current?.click(),
    },
  ];

  const accountActions: WorkbenchAction[] = [
    {
      key: "settings",
      label: "个人设置",
      icon: Settings,
      onSelect: () => router.push("/settings"),
    },
    ...(adminMode
      ? [
          {
            key: "admin",
            label: "管理后台",
            icon: Shield,
            onSelect: () => router.push("/admin"),
          },
        ]
      : []),
    {
      key: "recycle",
      label: "回收站",
      icon: Trash2,
      onSelect: () => router.push("/recycle-bin"),
    },
    {
      key: "logout",
      label: loggingOut ? "退出中…" : "退出登录",
      icon: LogOut,
      danger: true,
      separatorBefore: true,
      disabled: loggingOut,
      onSelect: () => void handleLogout(),
    },
  ];

  const interactions = useBrowserInteractions({
    items: browserItems,
    selectedKeys,
    onSelectionChange: setSelectedKeys,
    selectMode,
    coarsePointer,
    onOpen: openItem,
    onMenu: handleItemMenu,
    onRename: startRename,
    onDelete: requestDelete,
    dnd: {
      dropTargetKey: workbookDropTarget,
      draggingKeys: new Set(draggedWorkbookIds.map((id) => `workbook:${id}`)),
      onDragStart: handleItemDragStart,
      onDragEnd: handleInternalWorkbookDragEnd,
      onDragOver: handleWorkbookTargetDragOver,
      onDragLeave: handleWorkbookTargetDragLeave,
      onDrop: (event, folderId, canDrop) =>
        handleWorkbookTargetDrop(event, folderId, canDrop),
    },
  });
  const draggingKeys = new Set(
    draggedWorkbookIds.map((id) => `workbook:${id}`),
  );

  const locationLabel = ["根目录", ...breadcrumb.map((folder) => folder.name)].join(
    " / ",
  );
  const propertyRows = (item: BrowserItem | null): PropertyRow[] => {
    if (!item) return [];
    if (item.kind === "folder") {
      const folder = folderLookup.get(item.id);
      return [
        { label: "类型", value: item.typeLabel },
        { label: "位置", value: item.shared ? "共享给我" : locationLabel },
        {
          label: "所有者",
          value: folder?.owner_name || (folder ? `用户 #${folder.owner_id}` : "-"),
        },
        { label: "我的权限", value: folder ? folderAccessLabel(folder) : "-" },
        { label: "创建时间", value: formatDateTime(item.createdAt) },
        { label: "修改时间", value: formatDateTime(item.updatedAt) },
        { label: "ID", value: `#${item.id}` },
      ];
    }
    const workbook = workbookLookup.get(item.id);
    const source = workbook ? getWorkbookImportSource(workbook) : null;
    const status = [
      workbook?.is_locked
        ? `已锁定${workbook.locked_by_name ? `（${workbook.locked_by_name}）` : ""}`
        : "",
      workbook?.is_hidden
        ? `不可见${workbook.hidden_by_name ? `（${workbook.hidden_by_name}）` : ""}`
        : "",
      workbook?.is_public ? "公共工作簿" : "",
      workbook && isAssignedTaskWorkbook(workbook) ? "任务工作簿" : "",
    ].filter(Boolean);
    return [
      { label: "类型", value: item.typeLabel },
      { label: "位置", value: locationLabel },
      {
        label: "所有者",
        value:
          workbook?.owner_name || (workbook ? `用户 #${workbook.owner_id}` : "-"),
      },
      { label: "状态", value: status.length > 0 ? status.join("、") : "正常" },
      ...(source?.filename ? [{ label: "来源文件", value: source.filename }] : []),
      ...(workbook?.sheets?.length
        ? [{ label: "工作表", value: `${workbook.sheets.length} 个` }]
        : []),
      { label: "描述", value: workbook?.description?.trim() || "—" },
      { label: "创建时间", value: formatDateTime(item.createdAt) },
      { label: "修改时间", value: formatDateTime(item.updatedAt) },
      { label: "ID", value: `#${item.id}` },
    ];
  };

  const greeting = greetingFor(new Date());
  const folderCount = folderEntries.length;
  const workbookCount = sortedWorkbooks.length;
  const isSearching = Boolean(searchQuery.trim());
  const selectionActive = selectMode || selectedKeys.length > 1;
  const visibleTaskKeys = visibleAssignedTaskWorkbooks.map(
    (workbook) => `workbook:${workbook.id}`,
  );

  const apps: Array<{
    key: string;
    label: string;
    meta: string;
    href: string;
    icon: LucideIcon;
    tone: string;
    badge?: number;
    badgeTone?: "rose" | "amber" | "sky";
  }> = [
    { key: "trade", label: "外贸 ERP", meta: "询价 · 报价 · 发货", href: "/trade", icon: BriefcaseBusiness, tone: "bg-sky-600 text-white" },
    { key: "tasks", label: "任务中心", meta: totalTaskUnread > 0 ? `${totalTaskUnread} 项待处理` : "暂无待办", href: "/tasks", icon: CheckSquare, tone: "bg-amber-50 text-amber-700", badge: totalTaskUnread, badgeTone: "amber" },
    { key: "channels", label: "频道", meta: totalChannelUnread > 0 ? `${totalChannelUnread} 条未读` : "团队沟通", href: "/channels", icon: MessageSquare, tone: "bg-indigo-50 text-indigo-700", badge: totalChannelUnread },
    { key: "mail", label: "邮件", meta: mailSummary.configured ? (mailSummary.unread > 0 ? `${mailSummary.unread} 封未读` : "已全部阅读") : "未绑定邮箱", href: "/mail", icon: Mail, tone: "bg-sky-50 text-sky-700", badge: mailSummary.unread, badgeTone: "sky" },
    { key: "whatsapp", label: "WhatsApp", meta: "客户消息", href: "/whatsapp", icon: MessageCircle, tone: "bg-emerald-50 text-emerald-700" },
    { key: "gallery", label: "图库", meta: "图片素材", href: "/gallery", icon: Images, tone: "bg-violet-50 text-violet-700" },
    { key: "ai", label: "AI 总结", meta: "经营洞察", href: "/ai/summaries", icon: BarChart3, tone: "bg-slate-100 text-slate-700" },
    { key: "recycle", label: "回收站", meta: "30 天内可还原", href: "/recycle-bin", icon: Trash2, tone: "bg-rose-50 text-rose-600" },
    ...(adminMode
      ? [{ key: "admin", label: "管理后台", meta: "用户与权限", href: "/admin", icon: Shield, tone: "bg-slate-900 text-white" }]
      : []),
  ];

  const channelPanelBody = (
    <>
      <div className="max-h-80 overflow-y-auto">
        {unreadChannels.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            频道消息已全部阅读
          </div>
        ) : (
          unreadChannels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => {
                setChannelNotificationOpen(false);
                openChannelFromNotification(channel.id);
              }}
              className="flex min-h-14 w-full items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-left last:border-b-0 hover:bg-slate-50 active:bg-slate-100"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sky-50 text-sky-700">
                {channel.avatar_url ? (
                  <img src={channel.avatar_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-800">
                  {channel.name}
                </div>
                <div className="mt-0.5 truncate text-xs text-slate-400">
                  {channel.description || `${channel.member_count || 1} 位成员`}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                {channel.unread_count > 99 ? "99+" : channel.unread_count}
              </span>
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          setChannelNotificationOpen(false);
          router.push("/channels");
        }}
        className="flex h-11 w-full items-center justify-center gap-1 border-t border-slate-200 text-sm font-medium text-sky-700 hover:bg-sky-50"
      >
        进入频道
        <ArrowRight className="h-4 w-4" />
      </button>
    </>
  );

  const mailPanelBody = (
    <>
      <div className="px-4 py-5">
        {!mailSummary.configured ? (
          <div className="text-sm text-slate-500">
            尚未绑定工作邮箱，进入邮件客户端完成配置。
          </div>
        ) : mailSummary.last_error ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {mailSummary.last_error}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-50 text-sky-700">
              <Mail className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {mailSummary.unread > 0
                  ? `${mailSummary.unread} 封未读邮件`
                  : "邮件已全部阅读"}
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {mailSummary.address || "当前工作邮箱"} · 共 {mailSummary.total || 0} 封
              </div>
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          setMailNotificationOpen(false);
          router.push("/mail");
        }}
        className="flex h-11 w-full items-center justify-center gap-1 border-t border-slate-200 text-sm font-medium text-sky-700 hover:bg-sky-50"
      >
        进入邮件
        <ArrowRight className="h-4 w-4" />
      </button>
    </>
  );

  const headerIconButton =
    "relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 md:h-9 md:w-9 md:border md:border-slate-200";

  const header = (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-2 gap-y-2 px-3 py-2 md:h-16 md:flex-nowrap md:gap-x-3 md:px-5 md:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 md:flex-none">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white md:h-10 md:w-10">
            <FolderKanban className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-slate-950 md:text-lg">
              YaERP 工作台
            </h1>
            <p className="truncate text-xs text-slate-500">
              {greeting}，{profile?.username || "欢迎回来"}
              <span className="hidden sm:inline">
                {" · "}
                {profile?.roles?.[0]?.name || "普通用户"}
              </span>
            </p>
          </div>
        </div>

        <div
          ref={searchRef}
          className="relative order-last w-full md:order-none md:mx-auto md:max-w-xl md:flex-1"
        >
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchInputRef}
                type="search"
                enterKeyHint="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearchQuery("");
                    setSearchFocused(false);
                    event.currentTarget.blur();
                  }
                }}
                placeholder={
                  adminMode
                    ? "搜索当前目录：工作簿 / 文件夹 / 员工"
                    : "搜索当前目录的工作簿和文件夹"
                }
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-9 text-base text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100 md:h-9 md:text-sm [&::-webkit-search-cancel-button]:hidden"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchFocused(false);
                  }}
                  className="absolute right-0.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 md:h-8 md:w-8"
                  aria-label="清除搜索"
                  title="清除搜索"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new Event("yaerp:open-command-palette"))
              }
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:border-sky-200 hover:text-sky-700 md:h-9"
              title="搜索全部模块与工作簿（Ctrl / ⌘ + K）"
              aria-label="全库搜索"
            >
              <Command className="h-4 w-4" />
              <span className="hidden lg:inline">全库搜索</span>
              <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1 text-[10px] font-medium text-slate-400 xl:inline">
                Ctrl K
              </kbd>
            </button>
          </div>
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
              {suggestions.map((workbook) => (
                <button
                  key={workbook.id}
                  type="button"
                  onClick={() => {
                    router.push(`/sheets/${workbook.id}`);
                    setSearchFocused(false);
                  }}
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm transition hover:bg-slate-50 active:bg-slate-100"
                >
                  <ItemIcon
                    item={{ kind: "workbook", excelSource: hasWorkbookSourceXlsx(workbook) }}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-900">
                      {workbook.name}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      {workbook.owner_name || workbook.description || "无描述"}
                    </div>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div ref={notificationAreaRef} className="flex shrink-0 items-center gap-0.5 md:gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setMailNotificationOpen(false);
                setChannelNotificationOpen((current) => !current);
              }}
              className={headerIconButton}
              title="频道未读消息"
              aria-label="频道未读消息"
              aria-expanded={channelNotificationOpen}
            >
              <Bell className="h-[18px] w-[18px] md:h-4 md:w-4" />
              <CountBadge value={totalChannelUnread} />
            </button>
            {channelNotificationOpen && !isMobile && (
              <div className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">频道消息</div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {totalChannelUnread > 0 ? `${totalChannelUnread} 条未读` : "没有未读消息"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setChannelNotificationOpen(false)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                    aria-label="关闭频道消息"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {channelPanelBody}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => router.push("/tasks")}
            className={headerIconButton}
            title="任务中心"
            aria-label="任务中心"
          >
            <CheckSquare className="h-[18px] w-[18px] md:h-4 md:w-4" />
            <CountBadge value={totalTaskUnread} tone="amber" />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setChannelNotificationOpen(false);
                setMailNotificationOpen((current) => !current);
              }}
              className={headerIconButton}
              title={mailSummary.configured ? "邮件提醒" : "绑定工作邮箱"}
              aria-label="邮件提醒"
              aria-expanded={mailNotificationOpen}
            >
              <Mail className="h-[18px] w-[18px] md:h-4 md:w-4" />
              <CountBadge value={mailSummary.unread} tone="sky" />
            </button>
            {mailNotificationOpen && !isMobile && (
              <div className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <div className="text-sm font-semibold text-slate-900">邮件提醒</div>
                  <button
                    type="button"
                    onClick={() => setMailNotificationOpen(false)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                    aria-label="关闭邮件提醒"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {mailPanelBody}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={(event) =>
              openMenuAt(event.currentTarget, {
                title: profile?.username || "账户",
                subtitle: profile?.roles?.[0]?.name || "普通用户",
                actions: accountActions,
              })
            }
            className="ml-0.5 flex h-10 min-w-0 items-center gap-2 rounded-lg pl-0.5 pr-0.5 text-left transition hover:bg-slate-100 md:ml-1 md:border-l md:border-slate-200 md:pl-3 md:pr-2"
            title="账户与设置"
            aria-label="账户与设置"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
              {profile?.avatar ? (
                <img src={profile.avatar} alt="" className="h-full w-full object-cover" />
              ) : (
                profile?.username?.slice(0, 2).toUpperCase() || "U"
              )}
            </span>
            <span className="hidden min-w-0 lg:block">
              <span className="block max-w-28 truncate text-sm font-semibold text-slate-800">
                {profile?.username || "未加载"}
              </span>
              <span className="block max-w-28 truncate text-[11px] text-slate-400">
                {profile?.roles?.[0]?.name || "普通用户"}
              </span>
            </span>
          </button>
        </div>
      </div>
    </header>
  );

  const appsSection = (
    <section aria-label="应用" className="rounded-lg border border-slate-200 bg-white">
      <div className="flex gap-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] md:grid md:grid-cols-5 md:gap-0 md:overflow-visible md:p-0 xl:grid-cols-9 [&::-webkit-scrollbar]:hidden">
        {apps.map((app) => {
          const Icon = app.icon;
          return (
            <button
              key={app.key}
              type="button"
              onClick={() => router.push(app.href)}
              className="group flex w-[72px] shrink-0 flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-center transition active:bg-slate-100 md:w-auto md:flex-row md:gap-3 md:rounded-none md:border-b md:border-r md:border-slate-100 md:px-4 md:py-3 md:text-left md:hover:bg-slate-50 xl:border-b-0 xl:last:border-r-0"
            >
              <span className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl md:h-9 md:w-9 md:rounded-lg ${app.tone}`}>
                <Icon className="h-5 w-5 md:h-[18px] md:w-[18px]" />
                {app.badge ? <CountBadge value={app.badge} tone={app.badgeTone} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-slate-700 md:text-sm md:font-semibold md:text-slate-900">
                  {app.label}
                </span>
                <span className="hidden truncate text-[11px] text-slate-500 md:block">
                  {app.meta}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );

  const openPinned = (entry: PinnedEntry) => {
    if (entry.kind === "folder") {
      setSearchQuery("");
      void navigateToFolder(entry.id);
    } else router.push(`/sheets/${entry.id}`);
  };

  const quickAccessEntries: Array<{
    key: string;
    kind: "folder" | "workbook";
    id: number;
    name: string;
    meta: string;
    pinned: boolean;
    excelSource?: boolean;
  }> = [
    ...pinnedEntries
      .filter(
        (entry) =>
          entry.kind === "folder" ||
          workbooks.length === 0 ||
          workbookLookup.has(entry.id),
      )
      .slice(0, 8)
      .map((entry) => {
      const workbook = entry.kind === "workbook" ? workbookLookup.get(entry.id) : undefined;
      return {
        key: `pin-${entry.kind}-${entry.id}`,
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        meta: entry.kind === "folder" ? "收藏的文件夹" : workbook ? `收藏 · ${formatShortDate(workbook.updated_at)}` : "收藏的工作簿",
        pinned: true,
        excelSource: workbook ? hasWorkbookSourceXlsx(workbook) : false,
      };
    }),
    ...recentWorkbooks
      .filter((workbook) => !isPinned("workbook", workbook.id))
      .map((workbook) => ({
        key: `recent-${workbook.id}`,
        kind: "workbook" as const,
        id: workbook.id,
        name: workbook.name,
        meta: `${formatShortDate(workbook.updated_at)} 更新${workbook.owner_name && adminMode ? ` · ${workbook.owner_name}` : ""}`,
        pinned: false,
        excelSource: hasWorkbookSourceXlsx(workbook),
      })),
  ];

  const quickAccessStrip =
    quickAccessEntries.length > 0 && !isSearching ? (
      <section aria-label="快速访问" className="xl:hidden">
        <div className="mb-2 flex items-center justify-between px-0.5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <Clock3 className="h-4 w-4 text-slate-400" />
            快速访问
          </h2>
          <span className="text-xs text-slate-400">收藏与最近更新</span>
        </div>
        <div className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
          {quickAccessEntries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => openPinned(entry)}
              className="flex w-[200px] shrink-0 snap-start items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-slate-300 active:bg-slate-50"
            >
              <span className="relative">
                <ItemIcon item={entry} size="md" />
                {entry.pinned && (
                  <Star className="absolute -right-1 -top-1 h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{entry.name}</span>
                <span className="block truncate text-xs text-slate-500">{entry.meta}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    ) : null;

  const taskRows = [
    { key: "approvals", label: "待我审批", value: taskSummary.pending_approvals, href: "/tasks", icon: CheckSquare, tone: "text-amber-600" },
    { key: "erp", label: "ERP 任务", value: taskSummary.unread_erp_tasks, href: "/tasks", icon: ClipboardList, tone: "text-violet-600" },
    { key: "system", label: "系统通知", value: taskSummary.unread_system_notifications, href: "/tasks", icon: Bell, tone: "text-sky-600" },
    { key: "channels", label: "频道未读", value: totalChannelUnread, href: "/channels", icon: MessageSquare, tone: "text-indigo-600" },
    { key: "mail", label: "未读邮件", value: mailSummary.unread, href: "/mail", icon: Mail, tone: "text-sky-700" },
  ];

  const aside = (
    <aside className="hidden space-y-3 xl:block">
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex h-11 items-center justify-between border-b border-slate-200 px-4">
          <h2 className="text-sm font-semibold text-slate-900">待办与通知</h2>
          <button
            type="button"
            onClick={() => router.push("/tasks")}
            className="text-xs font-medium text-sky-700 hover:text-sky-900"
          >
            任务中心
          </button>
        </div>
        <div className="divide-y divide-slate-100">
          {taskRows.map((row) => {
            const Icon = row.icon;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => router.push(row.href)}
                className="flex h-10 w-full items-center gap-3 px-4 text-left text-sm transition hover:bg-slate-50"
              >
                <Icon className={`h-4 w-4 ${row.tone}`} />
                <span className="flex-1 text-slate-700">{row.label}</span>
                <span
                  className={`min-w-6 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums ${
                    row.value > 0 ? "bg-rose-50 text-rose-600" : "text-slate-300"
                  }`}
                >
                  {row.value > 99 ? "99+" : row.value}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex h-11 items-center justify-between border-b border-slate-200 px-4">
          <h2 className="text-sm font-semibold text-slate-900">快速访问</h2>
          <span className="text-xs text-slate-400">收藏 · 最近更新</span>
        </div>
        {quickAccessEntries.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs leading-5 text-slate-400">
            右键工作簿或文件夹选择“收藏到快速访问”，常用内容会出现在这里。
          </div>
        ) : (
          <div className="py-1">
            {quickAccessEntries.map((entry) => (
              <div key={entry.key} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => openPinned(entry)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2 text-left transition hover:bg-slate-50"
                >
                  <ItemIcon item={entry} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{entry.name}</span>
                    <span className="block truncate text-[11px] text-slate-400">{entry.meta}</span>
                  </span>
                </button>
                {entry.pinned && (
                  <button
                    type="button"
                    onClick={() => togglePinned([{ kind: entry.kind, id: entry.id, name: entry.name }])}
                    className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-lg text-amber-400 transition hover:bg-amber-50 hover:text-amber-600"
                    title="取消收藏"
                    aria-label={`取消收藏 ${entry.name}`}
                  >
                    <Star className="h-4 w-4 fill-current" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );

  const toolbarButton =
    "inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 md:h-9";

  const breadcrumbBar = (
    <nav aria-label="目录" className="flex min-w-0 flex-1 items-center gap-1">
      {currentFolderId !== null && (
        <button
          type="button"
          onClick={() =>
            void navigateToFolder(
              breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2].id : null,
            )
          }
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 md:h-8 md:w-8"
          aria-label="返回上一级"
          title="返回上一级"
        >
          <ChevronLeft className="h-5 w-5 md:h-4 md:w-4" />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={() => void navigateToFolder(null)}
          onDragOver={(event) => handleWorkbookTargetDragOver(event, "root", true)}
          onDragLeave={(event) => handleWorkbookTargetDragLeave(event, "root")}
          onDrop={(event) => handleWorkbookTargetDrop(event, null, true)}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-[15px] transition md:h-8 md:text-sm ${
            workbookDropTarget === "root"
              ? "bg-sky-100 text-sky-900 ring-2 ring-sky-300"
              : currentFolderId === null
                ? "font-semibold text-slate-900"
                : "font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          <Home className="h-4 w-4" />
          业务工作簿
        </button>
        {breadcrumb.map((folder) => {
          const targetKey = `breadcrumb-${folder.id}`;
          const isCurrent = folder.id === currentFolderId;
          const canDropHere = !isCurrent && folder.can_write !== false;
          return (
            <span key={folder.id} className="flex shrink-0 items-center gap-0.5">
              <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
              <button
                type="button"
                onClick={() => void navigateToFolder(folder.id)}
                onDragOver={(event) => handleWorkbookTargetDragOver(event, targetKey, canDropHere)}
                onDragLeave={(event) => handleWorkbookTargetDragLeave(event, targetKey)}
                onDrop={(event) => handleWorkbookTargetDrop(event, folder.id, canDropHere)}
                className={`inline-flex h-9 max-w-[180px] items-center truncate rounded-md px-2 text-[15px] transition md:h-8 md:text-sm ${
                  workbookDropTarget === targetKey
                    ? "bg-sky-100 text-sky-900 ring-2 ring-sky-300"
                    : isCurrent
                      ? "font-semibold text-slate-900"
                      : "font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <span className="truncate">{folder.name}</span>
              </button>
            </span>
          );
        })}
      </div>
    </nav>
  );

  const emptyState = (() => {
    if (folderLoading || folderError || browserItems.length > 0) return null;
    if (isSearching) {
      return (
        <div className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-6 py-14 text-center">
          <Search className="mb-3 h-8 w-8 text-slate-300" />
          <h3 className="text-base font-semibold text-slate-700">没有找到匹配的项目</h3>
          <p className="mt-1 text-sm text-slate-400">
            当前目录中没有与「{searchQuery.trim()}」匹配的工作簿或文件夹。
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => setSearchQuery("")} className={toolbarButton}>
              清除搜索
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("yaerp:open-command-palette"))}
              className={toolbarButton}
            >
              <Command className="h-4 w-4" />
              全库搜索
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-6 py-14 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-white text-slate-400 ring-1 ring-slate-200">
          {currentFolderId === null ? (
            <FolderKanban className="h-7 w-7" />
          ) : (
            <FolderOpen className="h-7 w-7" />
          )}
        </div>
        <h3 className="text-base font-semibold text-slate-800">
          {currentFolderId !== null
            ? "这个文件夹还是空的"
            : showOnlyOwnResources
              ? "还没有自己的工作簿或文件夹"
              : "还没有工作簿"}
        </h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">
          {!canWriteCurrentFolder
            ? "这是只读共享文件夹，暂时没有可查看的内容。"
            : currentFolderId !== null
              ? "新建工作簿、上传 Excel，或把其他工作簿拖到这里。"
              : showOnlyOwnResources
                ? "可以新建自己的文件夹或工作簿，关闭筛选后仍可查看其他有权限的资源。"
                : "从一个基础业务台账开始，后续可以逐步延展成销售、库存、采购和人事模块。也可以直接把 Excel 拖进来。"}
        </p>
        {canWriteCurrentFolder && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 md:h-9"
            >
              <Plus className="h-4 w-4" />
              新建工作簿
            </button>
            <button
              type="button"
              onClick={() => workbookImportInputRef.current?.click()}
              disabled={importBusy}
              className={toolbarButton}
            >
              <Upload className="h-4 w-4" />
              上传 Excel
            </button>
            <button type="button" onClick={() => setCreatingFolder(true)} className={toolbarButton}>
              <FolderPlus className="h-4 w-4" />
              新建文件夹
            </button>
          </div>
        )}
      </div>
    );
  })();

  const countLabel = folderLoading
    ? "正在加载…"
    : `${folderCount} 个文件夹 · ${workbookCount} 个工作簿${isSearching ? "（已筛选）" : ""}`;
  const countLabelShort = folderLoading ? "加载中…" : `${folderCount + workbookCount} 项`;

  const browserSection = (
    <section
      className="relative min-w-0 rounded-lg border border-slate-200 bg-white"
      onDragEnter={handleWorkbookDragEnter}
      onDragOver={handleWorkbookDragOver}
      onDragLeave={handleWorkbookDragLeave}
      onDrop={handleWorkbookDrop}
    >
      {workbookDropActive && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-sky-300 bg-sky-50/95 p-6 text-center backdrop-blur-sm">
          <div>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white text-sky-700 shadow-sm">
              <FileSpreadsheet className="h-6 w-6" />
            </div>
            <div className="mt-3 text-sm font-semibold text-slate-900">松开即可导入 Excel</div>
            <div className="mt-1 text-xs text-slate-500">
              支持同时拖入多个 Excel 文件或多个目录，并保留目录层级
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 border-b border-slate-200 px-3 py-2.5 md:px-4 md:py-3">
        <div className="flex min-w-0 items-center gap-2">
          {breadcrumbBar}
          <div className="shrink-0 text-xs text-slate-400 md:hidden">{countLabelShort}</div>
          <div className="hidden shrink-0 items-center gap-2 md:flex">
            <button
              type="button"
              onClick={() => setCreatingFolder(true)}
              disabled={!canWriteCurrentFolder}
              className={toolbarButton}
            >
              <FolderPlus className="h-4 w-4" />
              <span className="hidden lg:inline">新建文件夹</span>
            </button>
            <button
              type="button"
              onClick={() => workbookFolderImportInputRef.current?.click()}
              disabled={!canWriteCurrentFolder || importBusy}
              className={toolbarButton}
              title="上传 Excel 文件夹（保留目录结构）"
            >
              <FolderUp className="h-4 w-4" />
              <span className="hidden lg:inline">
                {importingWorkbookFolder ? `批量导入 ${workbookImportProgress}%` : "上传文件夹"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => workbookImportInputRef.current?.click()}
              disabled={!canWriteCurrentFolder || importBusy}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {importingWorkbook ? `导入中 ${workbookImportProgress}%` : "上传 Excel"}
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={!canWriteCurrentFolder || importBusy}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              新建工作簿
            </button>
          </div>
        </div>

        <div className="-mx-3 flex items-center gap-2 overflow-x-auto px-3 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
          <div className="mr-auto hidden text-xs text-slate-500 md:block">{countLabel}</div>
          {adminMode && (
            <button
              type="button"
              onClick={() => {
                const nextValue = !showOnlyOwnResources;
                setShowOnlyOwnResources(nextValue);
                if (nextValue && currentFolderMeta && currentFolderMeta.owner_id !== profile?.id) {
                  void navigateToFolder(null);
                }
              }}
              className={`${toolbarButton} ${showOnlyOwnResources ? "!border-sky-200 !bg-sky-50 !text-sky-700" : ""}`}
              title={showOnlyOwnResources ? "恢复查看全部工作簿和文件夹" : "仅显示自己创建的工作簿和文件夹"}
              aria-pressed={showOnlyOwnResources}
            >
              {showOnlyOwnResources ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
              仅看自己
            </button>
          )}
          {adminMode && workbookViewMode === "list" && (
            <button
              type="button"
              onClick={() => setGroupByOwner((current) => !current)}
              className={`${toolbarButton} ${groupByOwner ? "!border-sky-200 !bg-sky-50 !text-sky-700" : ""}`}
              aria-pressed={groupByOwner}
              title="按员工分组显示工作簿"
            >
              <Layers3 className="h-4 w-4" />
              <span className="hidden sm:inline">按员工分组</span>
            </button>
          )}
          {adminMode && visibleTaskKeys.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSelectMode(true);
                setSelectedKeys(visibleTaskKeys);
              }}
              className={toolbarButton}
              title="选中当前页全部任务工作簿，用于批量回收"
            >
              <ClipboardList className="h-4 w-4" />
              <span className="hidden sm:inline">选择任务工作簿</span>
            </button>
          )}
          <label className="relative inline-flex shrink-0">
            <span className="sr-only">排序方式</span>
            <select
              value={workbookSortBy}
              onChange={(event) => setWorkbookSortBy(event.target.value as WorkbenchSortKey)}
              className="h-10 appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm text-slate-700 outline-none transition hover:bg-slate-50 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 md:h-9"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  按{option.label}
                </option>
              ))}
            </select>
            <ChevronRight className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-slate-400" />
          </label>
          <button
            type="button"
            onClick={() => setWorkbookSortOrder((current) => (current === "desc" ? "asc" : "desc"))}
            className={`${toolbarButton} w-10 px-0 md:w-auto md:px-3`}
            title={workbookSortOrder === "desc" ? "当前降序，点击切换为升序" : "当前升序，点击切换为降序"}
            aria-label={workbookSortOrder === "desc" ? "降序" : "升序"}
          >
            <ArrowUpDown className="h-4 w-4" />
            <span className="hidden md:inline">{workbookSortOrder === "desc" ? "降序" : "升序"}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectMode) {
                setSelectMode(false);
                setSelectedKeys([]);
              } else setSelectMode(true);
            }}
            className={`${toolbarButton} ${selectMode ? "!border-sky-200 !bg-sky-50 !text-sky-700" : ""}`}
            aria-pressed={selectMode}
          >
            <CheckSquare className="h-4 w-4" />
            {selectMode ? "完成" : "选择"}
          </button>
          <div className="order-first inline-flex h-10 shrink-0 items-center rounded-lg bg-slate-100 p-1 md:order-none md:h-9" role="group" aria-label="显示方式">
            <button
              type="button"
              onClick={() => setWorkbookViewMode("desktop")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition md:h-7 ${
                workbookViewMode === "desktop" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
              aria-pressed={workbookViewMode === "desktop"}
              title="桌面图标视图"
            >
              <LayoutGrid className="h-4 w-4" />
              <span className="hidden sm:inline">桌面</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkbookViewMode("list")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition md:h-7 ${
                workbookViewMode === "list" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
              aria-pressed={workbookViewMode === "list"}
              title="详细列表视图"
            >
              <ListIcon className="h-4 w-4" />
              <span className="hidden sm:inline">列表</span>
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-2 md:p-4">
        {(importingWorkbook || importingWorkbookFolder || workbookFolderImportStatus || workbookImportError) && (
          <div
            className={`rounded-lg border px-3 py-2.5 text-sm ${
              workbookImportError ? "border-rose-200 bg-rose-50 text-rose-700" : "border-sky-200 bg-sky-50 text-sky-700"
            }`}
          >
            {workbookImportError ? (
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium">{workbookImportError}</span>
                <button type="button" onClick={() => setWorkbookImportError("")} aria-label="关闭提示" className="shrink-0">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-3 font-semibold">
                  <span className="truncate">
                    {importingWorkbookFolder
                      ? workbookFolderImportStatus || "正在批量导入 Excel 文件夹"
                      : importingWorkbook
                        ? "正在导入 Excel 工作簿"
                        : workbookFolderImportStatus}
                  </span>
                  <span className="tabular-nums">{workbookImportProgress}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-sky-500 transition-all duration-200" style={{ width: `${workbookImportProgress}%` }} />
                </div>
              </div>
            )}
          </div>
        )}
        {currentFolderMeta && !canWriteCurrentFolder && (
          <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-700">
            <Lock className="h-4 w-4 shrink-0" />
            当前位于只读共享文件夹中，可以查看和打开文件，但不能在这里新建或写入内容。
          </div>
        )}
        {(folderError || actionError) && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-medium text-rose-700">
            <span>{folderError || actionError}</span>
            {actionError && (
              <button type="button" onClick={() => setActionError("")} aria-label="关闭提示" className="shrink-0">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {folderLoading && browserItems.length === 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-[repeat(auto-fill,minmax(116px,1fr))]" aria-busy="true">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="flex h-[124px] flex-col items-center gap-2 rounded-lg bg-slate-50 p-3">
                <div className="h-14 w-14 animate-pulse rounded-lg bg-slate-200" />
                <div className="h-3 w-16 animate-pulse rounded bg-slate-200" />
              </div>
            ))}
          </div>
        )}

        {emptyState}

        {!folderError && browserItems.length > 0 &&
          (workbookViewMode === "desktop" ? (
            <FileIconView
              items={browserItems}
              interactions={interactions}
              selectMode={selectMode}
              coarsePointer={coarsePointer}
              dropTargetKey={workbookDropTarget}
              draggingKeys={draggingKeys}
              dragActive={draggedWorkbookIds.length > 0}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
            />
          ) : (
            <FileListView
              items={browserItems}
              interactions={interactions}
              selectMode={selectMode}
              coarsePointer={coarsePointer}
              dropTargetKey={workbookDropTarget}
              draggingKeys={draggingKeys}
              dragActive={draggedWorkbookIds.length > 0}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              grouped={groupedListMode}
              sortBy={workbookSortBy}
              sortOrder={workbookSortOrder}
              onSort={(key) => {
                if (key === workbookSortBy)
                  setWorkbookSortOrder((current) => (current === "desc" ? "asc" : "desc"));
                else {
                  setWorkbookSortBy(key);
                  setWorkbookSortOrder(key === "name" ? "asc" : "desc");
                }
              }}
              onOpen={openItem}
              onDownload={(item) => {
                const workbook = workbookLookup.get(item.id);
                if (workbook) void handleDownloadWorkbooks([workbook]);
              }}
              downloadingId={downloadingSourceWorkbookId}
            />
          ))}

        {!touchUi && browserItems.length > 0 && (
          <p className="hidden text-[11px] text-slate-400 md:block">
            {workbookViewMode === "desktop" ? "单击选择，双击打开；" : "单击名称打开；"}
            Ctrl / Shift 多选{workbookViewMode === "desktop" ? "，在空白处拖动框选" : ""}；右键或「⋯」查看全部操作；Enter 打开 · F2 重命名 · Delete 删除；可把工作簿拖到文件夹或路径上移动。
          </p>
        )}
      </div>

      {totalWorkbookPages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-3 py-2.5 md:px-4">
          <div className="text-xs text-slate-500">
            共 {sortedWorkbooks.length} 个工作簿 · 第 {workbookPage} / {totalWorkbookPages} 页
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWorkbookPage((current) => Math.max(1, current - 1))}
              disabled={workbookPage <= 1}
              className={`${toolbarButton} w-10 px-0 md:w-9`}
              aria-label="上一页"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setWorkbookPage((current) => Math.min(totalWorkbookPages, current + 1))}
              disabled={workbookPage >= totalWorkbookPages}
              className={`${toolbarButton} w-10 px-0 md:w-9`}
              aria-label="下一页"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <input
        ref={workbookImportInputRef}
        type="file"
        accept={EXCEL_IMPORT_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length === 1) void handleImportWorkbookXlsx(files[0]);
          if (files.length > 1)
            void handleImportDroppedWorkbooks(files.map((file) => ({ file, relativePath: file.name })));
        }}
      />
      <input
        ref={workbookFolderImportInputRef}
        type="file"
        accept={EXCEL_IMPORT_ACCEPT}
        multiple
        className="hidden"
        {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(event) => {
          if (event.target.files?.length) void handleImportWorkbookFolder(event.target.files);
        }}
      />
    </section>
  );

  const allVisibleSelected =
    browserItems.length > 0 && selectedKeys.length === browserItems.length;
  const exitSelection = () => {
    setSelectMode(false);
    setSelectedKeys([]);
  };
  const selectionButtons: Array<{
    key: string;
    label: string;
    icon: LucideIcon;
    onClick: (anchor: HTMLElement) => void;
    disabled?: boolean;
    danger?: boolean;
  }> = [
    {
      key: "move",
      label: "移动",
      icon: FolderInput,
      disabled: movableSelectedIds.length === 0,
      onClick: () =>
        openMoveDialog(movableSelectedIds, `移动 ${movableSelectedIds.length} 个工作簿`),
    },
    {
      key: "download",
      label: "下载",
      icon: Download,
      disabled: selectedWorkbooks.length === 0 || downloadingSourceWorkbookId !== null,
      onClick: () => void handleDownloadWorkbooks(selectedWorkbooks),
    },
    {
      key: "pin",
      label: "收藏",
      icon: Star,
      disabled: selectedItems.length === 0,
      onClick: () => togglePinned(selectedItems.map(itemToPinned)),
    },
    {
      key: "delete",
      label: "删除",
      icon: Trash2,
      danger: true,
      disabled: selectedItems.length === 0,
      onClick: () => requestDelete(selectedItems),
    },
    {
      key: "more",
      label: "更多",
      icon: Layers3,
      disabled: selectedItems.length === 0,
      onClick: (anchor) =>
        openMenuAt(anchor, {
          title: `已选择 ${selectedItems.length} 项`,
          icon: <CheckSquare className="h-5 w-5 text-sky-600" />,
          actions: buildBatchActions(selectedItems),
        }),
    },
  ];

  const selectionBar = selectionActive ? (
    <>
      {/* Phone: contextual bar covers the sticky header */}
      <div className="fixed inset-x-0 top-0 z-[45] border-b border-sky-200 bg-sky-50 pt-[env(safe-area-inset-top)] md:hidden">
        <div className="flex h-[104px] items-center gap-1 px-2">
          <button
            type="button"
            onClick={exitSelection}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 active:bg-sky-100"
            aria-label="退出选择"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-slate-900">
              {selectedKeys.length > 0 ? `已选 ${selectedKeys.length} 项` : "选择项目"}
            </div>
            <div className="truncate text-xs text-slate-500">轻点项目进行选择，在底部执行批量操作</div>
          </div>
          <button
            type="button"
            onClick={() =>
              setSelectedKeys(allVisibleSelected ? [] : browserItems.map((item) => item.key))
            }
            className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-semibold text-sky-700 active:bg-sky-100"
          >
            {allVisibleSelected ? "全不选" : "全选"}
          </button>
        </div>
      </div>
      {/* Phone: action bar above the tab bar. Desktop: floating toolbar. */}
      <div className="fixed inset-x-0 bottom-[var(--mobile-tabbar-offset)] z-[61] border-t border-slate-200 bg-white md:inset-x-auto md:bottom-6 md:left-1/2 md:-translate-x-1/2 md:rounded-lg md:border md:shadow-xl">
        <div className="flex items-center md:h-12 md:gap-1 md:px-2">
          <div className="hidden items-center gap-2 border-r border-slate-200 pl-1 pr-3 md:flex">
            <span className="text-sm font-semibold text-slate-900 tabular-nums">
              已选 {selectedKeys.length} 项
            </span>
            <button
              type="button"
              onClick={() =>
                setSelectedKeys(allVisibleSelected ? [] : browserItems.map((item) => item.key))
              }
              className="text-xs font-medium text-sky-700 hover:text-sky-900"
            >
              {allVisibleSelected ? "全不选" : "全选"}
            </button>
          </div>
          {selectionButtons.map((button) => {
            const Icon = button.icon;
            return (
              <button
                key={button.key}
                type="button"
                disabled={button.disabled}
                onClick={(event) => button.onClick(event.currentTarget)}
                className={`flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition disabled:opacity-35 md:h-9 md:flex-none md:flex-row md:gap-1.5 md:rounded-lg md:px-3 md:text-sm ${
                  button.danger
                    ? "text-rose-600 md:hover:bg-rose-50"
                    : "text-slate-700 md:hover:bg-slate-100"
                }`}
              >
                <Icon className="h-5 w-5 md:h-4 md:w-4" />
                {button.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={exitSelection}
            className="hidden h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 md:inline-flex"
            aria-label="取消选择"
            title="取消选择（Esc）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  ) : null;

  const fab =
    !selectionActive && canWriteCurrentFolder ? (
      <button
        type="button"
        onClick={(event) =>
          openMenuAt(event.currentTarget, {
            title: currentFolderMeta ? `新建到「${currentFolderMeta.name}」` : "新建",
            icon: <Plus className="h-5 w-5 text-slate-600" />,
            actions: createActions,
          })
        }
        className="fixed bottom-[calc(var(--mobile-tabbar-offset)+76px)] right-4 z-50 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-600 text-white shadow-lg shadow-sky-900/20 transition active:scale-95 md:hidden"
        aria-label="新建或上传"
      >
        {importBusy ? (
          <span className="text-xs font-semibold tabular-nums">{workbookImportProgress}%</span>
        ) : (
          <Plus className="h-6 w-6" strokeWidth={2.5} />
        )}
      </button>
    ) : null;

  const toast = notice ? (
    <div
      role="status"
      className={`pointer-events-none fixed left-1/2 z-[70] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
        selectionActive
          ? "bottom-[calc(var(--mobile-tabbar-offset)+72px)] md:bottom-24"
          : "bottom-[calc(var(--mobile-tabbar-offset)+16px)] md:bottom-6"
      }`}
    >
      {notice}
    </div>
  ) : null;

  const closeShareDialog = () => {
    setSharingFolder(null);
    setShareableUsers([]);
    setSelectedShares({});
    setShareMessage("");
  };
  const closeAssignDialog = () => {
    setAssigningWorkbook(null);
    setSelectedAssigneeIds([]);
  };

  const dialogs = (
    <>
      <ResponsiveDialog
        open={creating || creatingFolder}
        onClose={closeCreateDialogs}
        busy={createSaving}
        size="sm"
        title={creatingFolder ? "新建文件夹" : "新建工作簿"}
        description={`创建到「${currentFolderMeta?.name || "业务工作簿"}」`}
        icon={creatingFolder ? <FolderPlus className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
        footer={
          <>
            <button type="button" onClick={closeCreateDialogs} disabled={createSaving} className={dialogSecondaryButton}>
              取消
            </button>
            <button
              type="submit"
              form="workbench-create-form"
              disabled={createSaving || !(creatingFolder ? newFolderName : newName).trim()}
              className={dialogPrimaryButton}
            >
              {createSaving ? "创建中..." : "创建"}
            </button>
          </>
        }
      >
        <form
          id="workbench-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (creatingFolder) void handleCreateFolder();
            else void handleCreateWorkbook();
          }}
        >
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="workbench-create-name">
            {creatingFolder ? "文件夹名称" : "工作簿名称"}
          </label>
          <input
            id="workbench-create-name"
            type="text"
            value={creatingFolder ? newFolderName : newName}
            onChange={(event) => {
              if (creatingFolder) setNewFolderName(event.target.value);
              else setNewName(event.target.value);
              if (createError) setCreateError("");
            }}
            maxLength={256}
            placeholder={creatingFolder ? "例如：采购管理" : "例如：2026 年客户台账"}
            className={dialogInput}
            autoFocus
          />
          {createError && <div className="mt-2 text-xs font-medium text-rose-600">{createError}</div>}
        </form>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(editingWorkbook)}
        onClose={() => setEditingWorkbook(null)}
        size="sm"
        title="重命名工作簿"
        icon={<PencilLine className="h-5 w-5" />}
        footer={
          <>
            <button type="button" onClick={() => setEditingWorkbook(null)} className={dialogSecondaryButton}>
              取消
            </button>
            <button
              type="submit"
              form="workbench-rename-workbook"
              disabled={!editWorkbookName.trim()}
              className={dialogPrimaryButton}
            >
              保存
            </button>
          </>
        }
      >
        <form
          id="workbench-rename-workbook"
          onSubmit={(event) => {
            event.preventDefault();
            void handleRenameWorkbook();
          }}
        >
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="workbench-rename-workbook-name">
            工作簿名称
          </label>
          <input
            id="workbench-rename-workbook-name"
            type="text"
            value={editWorkbookName}
            onChange={(event) => setEditWorkbookName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            className={dialogInput}
            autoFocus
          />
        </form>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(folderBeingRenamed)}
        onClose={closeFolderRenameDialog}
        busy={folderRenameSaving}
        size="sm"
        title="重命名文件夹"
        description="修改后，文件夹内的工作簿和共享设置不会改变。"
        icon={<PencilLine className="h-5 w-5" />}
        footer={
          <>
            <button type="button" onClick={closeFolderRenameDialog} disabled={folderRenameSaving} className={dialogSecondaryButton}>
              取消
            </button>
            <button
              type="submit"
              form="workbench-rename-folder"
              disabled={folderRenameSaving || !folderRenameName.trim()}
              className={dialogPrimaryButton}
            >
              {folderRenameSaving ? "保存中..." : "保存名称"}
            </button>
          </>
        }
      >
        <form
          id="workbench-rename-folder"
          onSubmit={(event) => {
            event.preventDefault();
            void handleRenameFolder();
          }}
        >
          <label htmlFor="folder-rename-name" className="mb-1.5 block text-sm font-medium text-slate-700">
            文件夹名称
          </label>
          <input
            id="folder-rename-name"
            type="text"
            value={folderRenameName}
            onChange={(event) => {
              setFolderRenameName(event.target.value);
              if (folderRenameError) setFolderRenameError("");
            }}
            onFocus={(event) => event.currentTarget.select()}
            maxLength={256}
            disabled={folderRenameSaving}
            className={dialogInput}
            autoFocus
          />
          <div className="mt-2 flex min-h-5 items-start justify-between gap-3 text-xs">
            <span className="text-rose-600">{folderRenameError}</span>
            <span className="shrink-0 text-slate-400">{[...folderRenameName].length}/256</span>
          </div>
        </form>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(sharingFolder)}
        onClose={closeShareDialog}
        busy={shareSaving}
        size="lg"
        title="共享文件夹"
        description={
          sharingFolder
            ? `「${sharingFolder.name}」默认仅创建者和管理员可见，可按用户分别设置只读或可写共享。`
            : undefined
        }
        icon={<Share2 className="h-5 w-5" />}
        footer={
          <>
            <span className="mr-auto text-xs text-slate-500 max-md:hidden">
              已共享给 {Object.keys(selectedShares).length} 位用户
            </span>
            <button type="button" onClick={closeShareDialog} className={dialogSecondaryButton}>
              关闭
            </button>
            <button
              type="button"
              onClick={handleSaveFolderShares}
              disabled={shareSaving || shareLoading || shareLoadFailed}
              className={dialogPrimaryButton}
            >
              {shareSaving ? "保存中..." : "保存共享设置"}
            </button>
          </>
        }
      >
        {shareMessage && (
          <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700">
            {shareMessage}
          </div>
        )}
        <div className="space-y-2">
          {shareLoading ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
              正在加载可共享用户...
            </div>
          ) : shareableUsers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
              当前没有可共享的启用账号。
            </div>
          ) : (
            shareableUsers.map((user) => {
              const accessLevel = selectedShares[user.id];
              const checked = Boolean(accessLevel);
              return (
                <label
                  key={user.id}
                  className={`flex min-h-14 cursor-pointer flex-wrap items-center gap-3 rounded-lg border px-3 py-2 transition ${
                    checked ? "border-sky-200 bg-sky-50" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      setSelectedShares((current) => {
                        const next = { ...current };
                        if (event.target.checked) next[user.id] = next[user.id] || "view";
                        else delete next[user.id];
                        return next;
                      });
                    }}
                    className="h-5 w-5 rounded border-slate-300 text-sky-600 focus:ring-sky-500 md:h-4 md:w-4"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-900">{user.username}</div>
                    <div className="truncate text-xs text-slate-500">{user.email}</div>
                  </div>
                  <select
                    value={accessLevel || "view"}
                    disabled={!checked}
                    onChange={(event) => {
                      const value = event.target.value as "view" | "edit";
                      setSelectedShares((current) => ({ ...current, [user.id]: value }));
                    }}
                    className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
                  >
                    <option value="view">只读共享</option>
                    <option value="edit">可写共享</option>
                  </select>
                </label>
              );
            })
          )}
        </div>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(assigningWorkbook)}
        onClose={closeAssignDialog}
        busy={assignmentLoading}
        size="lg"
        title="发放任务工作簿"
        description={
          assigningWorkbook
            ? `将「${assigningWorkbook.name}」复制给选中的员工，作为待执行任务模板。`
            : undefined
        }
        icon={<UserRoundPlus className="h-5 w-5" />}
        footer={
          <>
            <span className="mr-auto text-xs text-slate-500 max-md:hidden">
              已选择 {selectedAssigneeIds.length} 位员工
            </span>
            <button type="button" onClick={closeAssignDialog} className={dialogSecondaryButton}>
              取消
            </button>
            <button
              type="button"
              onClick={handleAssignWorkbook}
              disabled={assignmentLoading || selectedAssigneeIds.length === 0}
              className={dialogPrimaryButton}
            >
              {assignmentLoading ? "发放中..." : `发放任务${selectedAssigneeIds.length ? `（${selectedAssigneeIds.length}）` : ""}`}
            </button>
          </>
        }
      >
        {assignmentMessage && (
          <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700">
            {assignmentMessage}
          </div>
        )}
        <div className="space-y-2">
          {assignableUsers.map((user) => {
            const checked = selectedAssigneeIds.includes(user.id);
            return (
              <label
                key={user.id}
                className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${
                  checked ? "border-sky-200 bg-sky-50" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setSelectedAssigneeIds((current) =>
                      event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id),
                    )
                  }
                  className="h-5 w-5 rounded border-slate-300 text-sky-600 focus:ring-sky-500 md:h-4 md:w-4"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-900">{user.username}</div>
                  <div className="truncate text-xs text-slate-500">{user.email}</div>
                </div>
              </label>
            );
          })}
          {assignableUsers.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
              暂无可发放任务的员工账号。
            </div>
          )}
        </div>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(confirmRequest)}
        onClose={() => setConfirmRequest(null)}
        busy={confirmBusy}
        size="sm"
        title={confirmRequest?.title || ""}
        icon={<Trash2 className="h-5 w-5 text-rose-600" />}
        footer={
          <>
            <button type="button" onClick={() => setConfirmRequest(null)} disabled={confirmBusy} className={dialogSecondaryButton}>
              取消
            </button>
            <button
              type="button"
              data-autofocus
              disabled={confirmBusy}
              onClick={async () => {
                if (!confirmRequest) return;
                setConfirmBusy(true);
                try {
                  await confirmRequest.onConfirm();
                } finally {
                  setConfirmBusy(false);
                  setConfirmRequest(null);
                }
              }}
              className={confirmRequest?.danger ? dialogDangerButton : dialogPrimaryButton}
            >
              {confirmBusy ? "处理中..." : confirmRequest?.confirmLabel}
            </button>
          </>
        }
      >
        <p className="text-sm leading-6 text-slate-600">{confirmRequest?.message}</p>
      </ResponsiveDialog>

      <MoveDialog
        open={Boolean(moveRequest)}
        title={moveRequest?.title || "移动到"}
        description="选择目标文件夹，只显示你有写入权限的位置。"
        targets={moveTargets}
        loading={moveTargetsLoading}
        busy={moveBusy}
        currentFolderId={currentFolderId}
        error={moveDialogError}
        onClose={() => setMoveRequest(null)}
        onConfirm={(folderId) => void confirmMove(folderId)}
      />

      <PropertiesDialog
        item={propertiesItem}
        rows={propertyRows(propertiesItem)}
        onClose={() => setPropertiesItem(null)}
        onOpen={openItem}
      />

      {isMobile && (
        <>
          <ResponsiveDialog
            open={channelNotificationOpen}
            onClose={() => setChannelNotificationOpen(false)}
            title="频道消息"
            description={totalChannelUnread > 0 ? `${totalChannelUnread} 条未读` : "没有未读消息"}
            icon={<Bell className="h-5 w-5" />}
            flush
          >
            {channelPanelBody}
          </ResponsiveDialog>
          <ResponsiveDialog
            open={mailNotificationOpen}
            onClose={() => setMailNotificationOpen(false)}
            title="邮件提醒"
            description={mailSummary.address || "当前工作邮箱"}
            icon={<Mail className="h-5 w-5" />}
            flush
          >
            {mailPanelBody}
          </ResponsiveDialog>
        </>
      )}

      <ActionMenu request={menuRequest} onClose={closeMenu} asSheet={touchUi} />

      <WhatsAppSendDialog
        open={Boolean(whatsAppResource)}
        resource={whatsAppResource}
        onClose={() => setWhatsAppResource(null)}
      />
    </>
  );

  return (
    <AuthGuard>
      <div className="min-h-screen overflow-x-clip bg-slate-100 text-slate-900">
        {header}
        <main className="mx-auto max-w-[1600px] space-y-3 p-3 pb-36 md:p-5 md:pb-24">
          {totalChannelUnread > 0 && unreadChannels.length > 0 && (
            <button
              type="button"
              onClick={() => openChannelFromNotification(unreadChannels[0].id)}
              className="flex w-full items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-left transition hover:bg-sky-100 md:px-4"
            >
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white">
                <MessageSquare className="h-4 w-4" />
                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-sky-50 bg-rose-500" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-sky-950">
                  频道有 {totalChannelUnread} 条未读消息
                </span>
                <span className="block truncate text-xs text-sky-700">
                  {unreadChannels.slice(0, 3).map((channel) => channel.name).join("、")}
                  {unreadChannels.length > 3 ? ` 等 ${unreadChannels.length} 个频道` : ""}
                </span>
              </span>
              <span className="hidden shrink-0 items-center gap-1 text-sm font-semibold text-sky-700 sm:inline-flex">
                查看消息
                <ArrowRight className="h-4 w-4" />
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-sky-500 sm:hidden" />
            </button>
          )}
          {appsSection}
          {quickAccessStrip}
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
            {browserSection}
            {aside}
          </div>
        </main>
        {selectionBar}
        {fab}
        {toast}
        {dialogs}
      </div>
    </AuthGuard>
  );
}
