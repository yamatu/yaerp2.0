"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Archive,
  ArrowLeft,
  EyeOff,
  FileSpreadsheet,
  Globe2,
  History,
  Lock,
  Maximize2,
  MessageCircle,
  Minimize2,
  Plus,
  Unlock,
} from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import SheetHistoryPanel from "@/components/sheets/SheetHistoryPanel";
import SheetTabBar, {
  type SheetStateAction,
} from "@/components/sheets/SheetTabBar";
import {
  WhatsAppSendDialog,
  type WhatsAppSendResource,
} from "@/components/whatsapp/WhatsAppSendDialog";
import {
  EXCEL_IMPORT_FORMATS_LABEL,
  isSupportedExcelImportFile,
  uploadWorkbookXlsx,
} from "@/components/spreadsheet/ImportXlsxButton";
import { useWorkbook } from "@/hooks/useSheet";
import { usePermission } from "@/hooks/usePermission";
import { useSheetWebSocket } from "@/hooks/useSheetWebSocket";
import { getStoredUser, isAdmin } from "@/lib/auth";
import api from "@/lib/api";
import { prepareDataMutation, publishActiveSheet } from "@/lib/dataEvents";
import { consumeReturnTarget } from "@/lib/returnNavigation";
import type { AuthUser, Sheet } from "@/types";

const UniverSheetEditor = dynamic(
  () => import("@/components/spreadsheet/UniverSheetEditor"),
  {
    ssr: false,
  },
);

interface Props {
  workbookId: string;
  requestedSheetId: number | null;
}

const EMPTY_SHEETS: Sheet[] = [];
const EMPTY_TAB_COLORS: Record<string, string> = {};

function lastViewedSheetStorageKey(userId: number, workbookId: string) {
  return `yaerp:workbook-view:${userId}:${workbookId}:last-sheet`;
}

function readLastViewedSheetId(userId: number, workbookId: string) {
  try {
    const value = Number(
      window.localStorage.getItem(
        lastViewedSheetStorageKey(userId, workbookId),
      ),
    );
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function rememberLastViewedSheet(
  userId: number,
  workbookId: string,
  sheetId: number,
) {
  try {
    window.localStorage.setItem(
      lastViewedSheetStorageKey(userId, workbookId),
      String(sheetId),
    );
  } catch {
    // Browsing still works when storage is unavailable.
  }
}

export default function WorkbookEditorShell({
  workbookId,
  requestedSheetId,
}: Props) {
  const router = useRouter();
  const { workbook, loading, error, refreshSilently } =
    useWorkbook(workbookId);
  const rootRef = useRef<HTMLDivElement>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [sheetActionError, setSheetActionError] = useState("");
  const [sheetActionLoading, setSheetActionLoading] = useState(false);
  const [optimisticEditableSheetId, setOptimisticEditableSheetId] = useState<
    number | null
  >(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [permissionToken, setPermissionToken] = useState(0);
  const [sidebarDragImportActive, setSidebarDragImportActive] = useState(false);
  const [sidebarDragImportUploading, setSidebarDragImportUploading] =
    useState(false);
  const [sidebarDragImportProgress, setSidebarDragImportProgress] = useState(0);
  const [whatsAppResource, setWhatsAppResource] =
    useState<WhatsAppSendResource | null>(null);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const sidebarDragDepthRef = useRef(0);

  const handleSheetReload = useCallback(async () => {
    await refreshSilently();
    setReloadToken((prev) => prev + 1);
    setPermissionToken((prev) => prev + 1);
  }, [refreshSilently]);

  // Keep the empty fallback stable so derived dependencies do not change on
  // every render while the workbook is loading.
  const sheets = workbook?.sheets ?? EMPTY_SHEETS;
  const isAdminUser = Boolean(currentUser && isAdmin(currentUser));
  const canManageWorkbook = Boolean(
    currentUser &&
    (workbook?.can_manage ??
      (isAdmin(currentUser) || currentUser.id === workbook?.owner_id)),
  );
  const tabColors = useMemo(() => {
    const raw = workbook?.metadata?.sheetTabColors;
    return raw && typeof raw === "object"
      ? (raw as Record<string, string>)
      : EMPTY_TAB_COLORS;
  }, [workbook?.metadata]);

  const handleSidebarDroppedXlsxImport = useCallback(
    async (file: File) => {
      if (!canManageWorkbook) {
        setSheetActionError("当前账号没有导入 Excel 的权限。");
        return;
      }

      setSheetActionError("");
      setSidebarDragImportUploading(true);
      setSidebarDragImportProgress(0);

      try {
        const result = await uploadWorkbookXlsx(workbookId, file, {
          onProgress: setSidebarDragImportProgress,
        });
        await handleSheetReload();
        router.replace(`/sheets/${workbookId}/${result.sheet_id}`);
      } catch (error) {
        setSheetActionError(
          error instanceof Error
            ? error.message
            : "Import failed. Please try again later.",
        );
      } finally {
        setSidebarDragImportUploading(false);
        setSidebarDragImportActive(false);
        sidebarDragDepthRef.current = 0;
        window.setTimeout(() => setSidebarDragImportProgress(0), 400);
      }
    },
    [canManageWorkbook, handleSheetReload, router, workbookId],
  );

  const handleSidebarDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canManageWorkbook || sidebarDragImportUploading) return;
      const hasFile = Array.from(event.dataTransfer.types || []).includes(
        "Files",
      );
      if (!hasFile) return;
      event.preventDefault();
      sidebarDragDepthRef.current += 1;
      setSidebarDragImportActive(true);
    },
    [canManageWorkbook, sidebarDragImportUploading],
  );

  const handleSidebarDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canManageWorkbook || sidebarDragImportUploading) return;
      const hasFile = Array.from(event.dataTransfer.types || []).includes(
        "Files",
      );
      if (!hasFile) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [canManageWorkbook, sidebarDragImportUploading],
  );

  const handleSidebarDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canManageWorkbook || sidebarDragImportUploading) return;
      const hasFile = Array.from(event.dataTransfer.types || []).includes(
        "Files",
      );
      if (!hasFile) return;
      event.preventDefault();
      sidebarDragDepthRef.current = Math.max(
        0,
        sidebarDragDepthRef.current - 1,
      );
      if (sidebarDragDepthRef.current === 0) {
        setSidebarDragImportActive(false);
      }
    },
    [canManageWorkbook, sidebarDragImportUploading],
  );

  const handleSidebarDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canManageWorkbook || sidebarDragImportUploading) return;
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length === 0) return;
      event.preventDefault();
      sidebarDragDepthRef.current = 0;
      setSidebarDragImportActive(false);
      const excelFile = files.find(isSupportedExcelImportFile);
      if (!excelFile) {
        setSheetActionError(
          `请拖入 ${EXCEL_IMPORT_FORMATS_LABEL} 格式的文件。`,
        );
        return;
      }
      void handleSidebarDroppedXlsxImport(excelFile);
    },
    [
      canManageWorkbook,
      handleSidebarDroppedXlsxImport,
      sidebarDragImportUploading,
    ],
  );

  const activeSheet = useMemo(() => {
    if (requestedSheetId === null) return null;
    return sheets.find((sheet) => sheet.id === requestedSheetId) ?? null;
  }, [requestedSheetId, sheets]);

  useEffect(() => {
    setHistoryPanelOpen(false);
  }, [activeSheet?.id]);

  const { loading: permissionLoading, refreshPermissions } = usePermission(
    activeSheet?.id ?? 0,
  );

  useEffect(() => {
    if (permissionToken > 0) refreshPermissions();
  }, [permissionToken, refreshPermissions]);

  useSheetWebSocket(activeSheet?.id ?? 0, handleSheetReload);

  useEffect(() => {
    setCurrentUser(getStoredUser());
  }, []);

  useEffect(() => {
    document.body.classList.add("has-sheet-tabbar");
    return () => document.body.classList.remove("has-sheet-tabbar");
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Recompute the id list only when the workbook's sheet collection changes.
  const sheetIds = useMemo(() => sheets.map((s) => s.id), [sheets]);

  useEffect(() => {
    if (loading || !workbook) return;
    if (!currentUser?.id) return;
    if (sheetIds.length === 0) return;

    if (requestedSheetId === null || !sheetIds.includes(requestedSheetId)) {
      const rememberedSheetId = readLastViewedSheetId(
        currentUser.id,
        workbookId,
      );
      const firstVisible = sheets.find((sheet) => !sheet.is_hidden) ?? sheets[0];
      const targetSheetId =
        rememberedSheetId && sheetIds.includes(rememberedSheetId)
          ? rememberedSheetId
          : firstVisible.id;
      router.replace(`/sheets/${workbookId}/${targetSheetId}`);
    }
  }, [
    currentUser?.id,
    loading,
    requestedSheetId,
    router,
    sheetIds,
    sheets,
    workbook,
    workbookId,
  ]);

  useEffect(() => {
    if (!currentUser?.id || !activeSheet?.id) return;
    rememberLastViewedSheet(currentUser.id, workbookId, activeSheet.id);
  }, [activeSheet?.id, currentUser?.id, workbookId]);

  useEffect(() => {
    if (!activeSheet?.id) return;
    publishActiveSheet({ workbookId: Number(workbookId), sheetId: activeSheet.id });
  }, [activeSheet?.id, workbookId]);

  useEffect(() => () => publishActiveSheet(null), []);

  useEffect(() => {
    if (!activeSheet || optimisticEditableSheetId === null) return;
    if (activeSheet.id !== optimisticEditableSheetId) return;
    if (!permissionLoading) {
      setOptimisticEditableSheetId(null);
    }
  }, [activeSheet, optimisticEditableSheetId, permissionLoading]);

  useEffect(() => {
    if (!requestedSheetId) {
      setOptimisticEditableSheetId(null);
    }
  }, [requestedSheetId]);

  const openSheet = (sheet: Sheet) => {
    setSheetActionError("");
    router.push(`/sheets/${workbookId}/${sheet.id}`);
  };

  const nextSheetName = () => {
    const names = new Set(sheets.map((sheet) => sheet.name.trim().toLowerCase()));
    let index = sheets.length + 1;
    while (names.has(`sheet${index}`)) index += 1;
    return `Sheet${index}`;
  };

  // Places newSheetId into the tab order; null beforeId appends it.
  const placeSheet = async (newSheetId: number, beforeId: number | null) => {
    if (beforeId === null) return;
    const ids = sheets.map((sheet) => sheet.id).filter((id) => id !== newSheetId);
    const at = ids.indexOf(beforeId);
    if (at < 0) return;
    ids.splice(at, 0, newSheetId);
    const res = await api.put(`/workbooks/${workbookId}/sheet-tabs`, { order: ids });
    if (res.code !== 0) {
      setSheetActionError(res.message || "调整工作表位置失败。");
    }
  };

  const sheetAfter = (sheet: Sheet) => {
    const index = sheets.findIndex((item) => item.id === sheet.id);
    return sheets[index + 1]?.id ?? null;
  };

  const handleInsertSheet = async (after: Sheet | null) => {
    if (!canManageWorkbook) {
      setSheetActionError("当前账号不能在这个工作簿里新建工作表。");
      return;
    }
    if (sheetActionLoading) return;
    setSheetActionError("");
    setSheetActionLoading(true);
    try {
      const res = await api.post<Sheet>(`/workbooks/${workbookId}/sheets`, {
        name: nextSheetName(),
        columns: [],
      });
      if (res.code !== 0 || !res.data) {
        setSheetActionError(res.message || "新建工作表失败，请稍后再试。");
        return;
      }
      if (after) await placeSheet(res.data.id, sheetAfter(after));
      setOptimisticEditableSheetId(res.data.id);
      await refreshSilently();
      router.replace(`/sheets/${workbookId}/${res.data.id}`);
    } catch (err) {
      console.error("Failed to add sheet:", err);
      setSheetActionError("新建工作表失败，请稍后再试。");
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleDeleteSheets = async (targets: Sheet[]) => {
    if (!canManageWorkbook || targets.length === 0 || sheetActionLoading) return;
    const names = targets
      .slice(0, 3)
      .map((sheet) => `「${sheet.name || "未命名工作表"}」`)
      .join("、");
    const suffix = targets.length > 3 ? ` 等 ${targets.length} 个工作表` : "";
    if (!window.confirm(`确定删除 ${names}${suffix} 吗？此操作不可撤销。`)) return;

    setSheetActionError("");
    setSheetActionLoading(true);
    const removed = new Set(targets.map((sheet) => sheet.id));
    const activeIndex = sheets.findIndex((sheet) => sheet.id === activeSheet?.id);
    const fallbackSheet =
      sheets.slice(activeIndex + 1).find((sheet) => !removed.has(sheet.id) && !sheet.is_hidden) ??
      [...sheets.slice(0, Math.max(activeIndex, 0))].reverse().find((sheet) => !removed.has(sheet.id) && !sheet.is_hidden) ??
      sheets.find((sheet) => !removed.has(sheet.id)) ??
      null;
    try {
      const results = await Promise.all(
        targets.map((sheet) => api.delete(`/sheets/${sheet.id}`)),
      );
      const failure = results.find((result) => result.code !== 0);
      if (failure) {
        setSheetActionError(failure.message || "部分工作表删除失败，请刷新后重试。");
      }
      await refreshSilently();
      if (activeSheet && removed.has(activeSheet.id)) {
        router.replace(
          fallbackSheet
            ? `/sheets/${workbookId}/${fallbackSheet.id}`
            : `/sheets/${workbookId}`,
        );
      }
    } catch (err) {
      console.error("Failed to delete sheets:", err);
      setSheetActionError("删除工作表失败，请稍后再试。");
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleDuplicateSheet = async (
    targetSheet: Sheet,
    beforeId?: number | null,
  ) => {
    if (!canManageWorkbook || sheetActionLoading) return;

    setSheetActionError("");
    setSheetActionLoading(true);
    try {
      if (targetSheet.id === activeSheet?.id) {
        await prepareDataMutation();
      }
      const res = await api.post<Sheet>(`/sheets/${targetSheet.id}/duplicate`);
      if (res.code !== 0 || !res.data) {
        setSheetActionError(res.message || "复制工作表失败，请稍后再试。");
        return;
      }
      await placeSheet(
        res.data.id,
        beforeId === undefined ? sheetAfter(targetSheet) : beforeId,
      );
      setOptimisticEditableSheetId(res.data.id);
      await refreshSilently();
      router.replace(`/sheets/${workbookId}/${res.data.id}`);
    } catch (err) {
      console.error("Failed to duplicate sheet:", err);
      setSheetActionError(
        err instanceof Error ? err.message : "复制工作表失败，请稍后再试。",
      );
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleRenameSheet = async (sheet: Sheet, nextName: string) => {
    if (!canManageWorkbook) {
      setSheetActionError("当前账号不能重命名这个工作表。");
      return false;
    }
    const duplicate = sheets.some(
      (item) =>
        item.id !== sheet.id &&
        item.name.trim().toLowerCase() === nextName.toLowerCase(),
    );
    if (duplicate) {
      setSheetActionError(`已存在名为「${nextName}」的工作表，请换一个名称。`);
      return false;
    }

    setSheetActionError("");
    setSheetActionLoading(true);
    try {
      if (sheet.id === activeSheet?.id) await prepareDataMutation();
      const res = await api.put(`/sheets/${sheet.id}`, { name: nextName });
      if (res.code !== 0) {
        setSheetActionError(res.message || "重命名工作表失败，请稍后再试。");
        return false;
      }
      await handleSheetReload();
      return true;
    } catch (err) {
      console.error("Failed to rename sheet:", err);
      setSheetActionError("重命名工作表失败，请稍后再试。");
      return false;
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleReorderSheets = async (orderedIds: number[]) => {
    if (!canManageWorkbook || sheetActionLoading) return;
    setSheetActionError("");
    setSheetActionLoading(true);
    try {
      const res = await api.put(`/workbooks/${workbookId}/sheet-tabs`, {
        order: orderedIds,
      });
      if (res.code !== 0) {
        setSheetActionError(res.message || "移动工作表失败，请稍后再试。");
      }
      await refreshSilently();
    } catch (err) {
      console.error("Failed to reorder sheets:", err);
      setSheetActionError("移动工作表失败，请稍后再试。");
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleSheetTabColor = async (targets: Sheet[], color: string) => {
    if (!canManageWorkbook || sheetActionLoading) return;
    setSheetActionError("");
    setSheetActionLoading(true);
    try {
      const res = await api.put(`/workbooks/${workbookId}/sheet-tabs`, {
        colors: Object.fromEntries(targets.map((sheet) => [String(sheet.id), color])),
      });
      if (res.code !== 0) {
        setSheetActionError(res.message || "设置标签颜色失败，请稍后再试。");
      }
      await refreshSilently();
    } catch (err) {
      console.error("Failed to set sheet tab color:", err);
      setSheetActionError("设置标签颜色失败，请稍后再试。");
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleUpdateWorkbookState = async (
    action: "lock" | "unlock" | "hide" | "unhide" | "publish" | "unpublish",
  ) => {
    if (!workbook) return;
    const confirmation =
      action === "publish"
        ? `设为公共表后，所有员工都可以查看、编辑和导出「${workbook.name}」。\n数据遮罩、隐藏公式和保护区域仍然生效。确定继续吗？`
        : action === "unpublish"
          ? `取消公共表后，只有被单独授权的成员还能访问「${workbook.name}」。确定继续吗？`
          : "";
    if (confirmation && !window.confirm(confirmation)) return;
    setSheetActionError("");
    setSheetActionLoading(true);

    try {
      const res = await api.put(`/workbooks/${workbook.id}/state`, { action });
      if (res.code !== 0) {
        setSheetActionError(res.message || "更新工作簿状态失败，请稍后再试。");
        return;
      }
      await refreshSilently();
      setPermissionToken((prev) => prev + 1);
      if (action === "hide" && !isAdminUser) {
        router.replace("/");
      }
    } catch (err) {
      console.error("Failed to update workbook state:", err);
      setSheetActionError("更新工作簿状态失败，请稍后再试。");
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleUpdateSheetStates = async (
    targets: Sheet[],
    action: SheetStateAction,
  ) => {
    if (targets.length === 0 || sheetActionLoading) return;
    setSheetActionError("");
    setSheetActionLoading(true);
    try {
      const results = await Promise.all(
        targets.map((sheet) => api.put(`/sheets/${sheet.id}/state`, { action })),
      );
      const failure = results.find((result) => result.code !== 0);
      if (failure) {
        setSheetActionError(failure.message || "更新工作表状态失败，请稍后再试。");
      }
      await refreshSilently();
      setPermissionToken((prev) => prev + 1);
      if (action === "hide" && activeSheet && targets.some((sheet) => sheet.id === activeSheet.id)) {
        const hidden = new Set(targets.map((sheet) => sheet.id));
        const activeIndex = sheets.findIndex((sheet) => sheet.id === activeSheet.id);
        const neighbour =
          sheets.slice(activeIndex + 1).find((sheet) => !sheet.is_hidden && !hidden.has(sheet.id)) ??
          [...sheets.slice(0, activeIndex)].reverse().find((sheet) => !sheet.is_hidden && !hidden.has(sheet.id));
        if (neighbour) router.replace(`/sheets/${workbookId}/${neighbour.id}`);
      }
    } catch (err) {
      console.error("Failed to update sheet state:", err);
      setSheetActionError("更新工作表状态失败，请稍后再试。");
    } finally {
      setSheetActionLoading(false);
    }
  };

  const handleFullscreenToggle = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await rootRef.current?.requestFullscreen();
    } catch (err) {
      console.error("Failed to toggle fullscreen:", err);
      setSheetActionError("切换全屏失败，请确认浏览器允许全屏。");
    }
  };

  if (loading) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-sky-600">
              Loading
            </div>
            <div className="text-lg font-semibold text-slate-900">
              正在加载工作簿...
            </div>
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (error || !workbook) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-rose-500">
              Oops
            </div>
            <div className="text-lg font-semibold text-slate-900">
              {error || "工作簿未找到"}
            </div>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div
        ref={rootRef}
        className={`flex flex-col bg-slate-50 ${fullscreen ? "fixed inset-0 z-50" : "h-screen"}`}
      >
        <div className="flex min-h-[56px] items-center justify-between gap-2 border-b border-slate-200 bg-white px-2 py-2 sm:min-h-[68px] sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
            <button
              type="button"
              onClick={() => router.push(consumeReturnTarget("/"))}
              className="order-first inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2 text-sm leading-none text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 sm:order-none sm:h-9 sm:min-w-0 sm:border-0 sm:px-2.5 sm:text-slate-500"
              title="返回工作台"
              aria-label="返回工作台"
            >
              <ArrowLeft className="h-5 w-5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">返回</span>
            </button>
            <div className="hidden h-5 w-px bg-slate-200 sm:block" />
            <div className="flex min-w-0 flex-col justify-center">
              <div className="hidden text-[11px] font-semibold uppercase leading-4 tracking-[0.28em] text-sky-600 sm:block">
                Workbook
              </div>
              <h1 className="max-w-[110px] truncate text-sm font-semibold leading-5 text-slate-900 sm:max-w-[320px]">
                {workbook.name}
              </h1>
              {activeSheet && (
                <div className="mt-1 hidden flex-wrap gap-2 sm:flex">
                  {workbook.is_locked && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                      <Lock className="h-3 w-3" /> 工作簿已锁定
                    </span>
                  )}
                  {workbook.is_hidden && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                      <EyeOff className="h-3 w-3" /> 工作簿不可见
                    </span>
                  )}
                  {workbook.is_public && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                      <Globe2 className="h-3 w-3" /> 公共工作簿
                    </span>
                  )}
                  {activeSheet.is_locked && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                      <Lock className="h-3 w-3" /> 已锁定
                    </span>
                  )}
                  {activeSheet.is_archived && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                      <Archive className="h-3 w-3" /> 已归档
                    </span>
                  )}
                  {activeSheet.is_hidden && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700">
                      <EyeOff className="h-3 w-3" /> 已隐藏
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {activeSheet && (
              <button
                type="button"
                onClick={() => setHistoryPanelOpen(true)}
                className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                title="版本与操作历史"
                aria-label="打开版本与操作历史"
                data-tooltip="版本与操作历史"
              >
                <History className="h-4 w-4" />
              </button>
            )}
            {activeSheet && (
              <button
                type="button"
                onClick={() =>
                  setWhatsAppResource({
                    sheetId: activeSheet.id,
                    title: `${workbook.name} / ${activeSheet.name}`,
                    defaultContent: `工作表：${workbook.name} / ${activeSheet.name}`,
                  })
                }
                className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-200 text-emerald-600 transition hover:bg-emerald-50"
                title="发送当前工作表到 WhatsApp"
                aria-label="发送当前工作表到 WhatsApp"
                data-tooltip="发送到 WhatsApp"
              >
                <MessageCircle className="h-4 w-4" />
              </button>
            )}
            {canManageWorkbook && activeSheet && (
              <button
                type="button"
                onClick={() =>
                  void handleUpdateWorkbookState(
                    workbook.is_public ? "unpublish" : "publish",
                  )
                }
                disabled={sheetActionLoading}
                className={`hidden items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 md:inline-flex ${workbook.is_public ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}
                title={workbook.is_public ? "取消公共访问" : "设为公共工作簿"}
              >
                <Globe2 className="h-3.5 w-3.5" />
                {sheetActionLoading
                  ? "处理中..."
                  : workbook.is_public
                    ? "公共表"
                    : "设为公共表"}
              </button>
            )}
            {isAdminUser && activeSheet && (
              <button
                type="button"
                onClick={() =>
                  void handleUpdateWorkbookState(
                    workbook.is_locked ? "unlock" : "lock",
                  )
                }
                disabled={sheetActionLoading}
                className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 md:inline-flex"
              >
                {workbook.is_locked ? (
                  <Unlock className="h-3.5 w-3.5" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                {workbook.is_locked ? "解除工作簿锁定" : "锁定工作簿"}
              </button>
            )}
            {isAdminUser && activeSheet && (
              <button
                type="button"
                onClick={() =>
                  void handleUpdateWorkbookState(
                    workbook.is_hidden ? "unhide" : "hide",
                  )
                }
                disabled={sheetActionLoading}
                className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 md:inline-flex"
              >
                <EyeOff className="h-3.5 w-3.5" />
                {workbook.is_hidden ? "恢复工作簿可见" : "设为工作簿不可见"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleFullscreenToggle()}
              className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={fullscreen ? "退出全屏" : "全屏"}
              aria-label={fullscreen ? "退出全屏" : "进入全屏"}
              data-tooltip={fullscreen ? "退出全屏" : "进入全屏"}
              data-tooltip-side="left"
            >
              {fullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {sheetActionError && (
          <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {sheetActionError}
          </div>
        )}

        {activeSheet &&
          (activeSheet.is_locked || activeSheet.is_archived) &&
          !isAdminUser && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              {activeSheet.is_archived
                ? "当前工作表已归档，仅管理员可以修改。"
                : "当前工作表已锁定，仅管理员可以修改或解除锁定。"}
            </div>
          )}

        {workbook.is_locked && !isAdminUser && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            当前工作簿已被管理员锁定，你可以查看和重命名，但不能继续修改表格内容。
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1">
            {activeSheet ? (
              <UniverSheetEditor
                key={activeSheet.id}
                workbookId={workbookId}
                workbookName={workbook.name}
                workbookSheets={sheets.map((item) => ({
                  id: item.id,
                  name: item.name,
                }))}
                sheet={activeSheet}
                reloadToken={String(reloadToken)}
                permissionToken={permissionToken}
                onExternalReload={refreshSilently}
                optimisticCanEdit={
                  optimisticEditableSheetId === activeSheet.id ||
                  (canManageWorkbook &&
                    (isAdminUser ||
                      (!workbook.is_locked &&
                        !activeSheet.is_locked &&
                        !activeSheet.is_archived)))
                }
                canImportWorkbook={canManageWorkbook}
              />
            ) : sheets.length === 0 ? (
              <div className="flex h-full items-center justify-center bg-slate-50 text-center">
                <div className="max-w-sm">
                  <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                  <h2 className="text-xl font-semibold text-slate-900">
                    此工作簿还没有工作表
                  </h2>
                  <p className="mt-2 text-sm text-slate-500">
                    点击下方「+」或这里新建一个工作表。
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleInsertSheet(null)}
                    disabled={!canManageWorkbook || sheetActionLoading}
                    className="mt-6 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" />
                    新建工作表
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center bg-slate-50 text-center">
                <div className="max-w-sm">
                  <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                  <h2 className="text-xl font-semibold text-slate-900">
                    正在打开工作表...
                  </h2>
                </div>
              </div>
            )}
          </div>
          <SheetTabBar
            sheets={sheets}
            activeSheetId={activeSheet?.id ?? null}
            tabColors={tabColors}
            canManage={canManageWorkbook}
            isAdmin={isAdminUser}
            busy={sheetActionLoading}
            importState={{
              active: sidebarDragImportActive,
              uploading: sidebarDragImportUploading,
              progress: sidebarDragImportProgress,
            }}
            dropHandlers={{
              onDragEnter: handleSidebarDragEnter,
              onDragOver: handleSidebarDragOver,
              onDragLeave: handleSidebarDragLeave,
              onDrop: handleSidebarDrop,
            }}
            onOpen={openSheet}
            onInsert={(after) => void handleInsertSheet(after)}
            onRename={handleRenameSheet}
            onDelete={(targets) => void handleDeleteSheets(targets)}
            onDuplicate={(sheet, beforeId) => void handleDuplicateSheet(sheet, beforeId)}
            onReorder={(ids) => void handleReorderSheets(ids)}
            onColor={(targets, color) => void handleSheetTabColor(targets, color)}
            onState={(targets, action) => void handleUpdateSheetStates(targets, action)}
            onShare={(sheet) =>
              setWhatsAppResource({
                sheetId: sheet.id,
                title: `${workbook.name} / ${sheet.name}`,
                defaultContent: `工作表：${workbook.name} / ${sheet.name}`,
              })
            }
          />
        </main>

        {historyPanelOpen && activeSheet && (
          <SheetHistoryPanel
            sheetId={activeSheet.id}
            sheetName={activeSheet.name || "未命名工作表"}
            canManage={canManageWorkbook}
            onClose={() => setHistoryPanelOpen(false)}
            onBeforeMutation={prepareDataMutation}
            onRestored={handleSheetReload}
          />
        )}
        <WhatsAppSendDialog
          open={Boolean(whatsAppResource)}
          resource={whatsAppResource}
          onClose={() => setWhatsAppResource(null)}
        />
      </div>
    </AuthGuard>
  );
}
