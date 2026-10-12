"use client";

import { Check, FolderIcon, FolderInput, Home, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveDialog,
  dialogInput,
  dialogPrimaryButton,
  dialogSecondaryButton,
} from "./ResponsiveDialog";

export interface MoveTarget {
  id: number | null;
  name: string;
  path: string;
}

interface MoveDialogProps {
  open: boolean;
  title: string;
  description?: string;
  targets: MoveTarget[];
  loading: boolean;
  busy: boolean;
  currentFolderId: number | null;
  error?: string;
  onClose: () => void;
  onConfirm: (folderId: number | null) => void;
}

/** Folder picker used by "移动到…" for single and batch moves. */
export function MoveDialog({
  open,
  title,
  description,
  targets,
  loading,
  busy,
  currentFolderId,
  error,
  onClose,
  onConfirm,
}: MoveDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(undefined);
    }
  }, [open]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return targets;
    return targets.filter(
      (target) =>
        target.name.toLowerCase().includes(keyword) ||
        target.path.toLowerCase().includes(keyword),
    );
  }, [query, targets]);

  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={title}
      description={description}
      icon={<FolderInput className="h-5 w-5" />}
      flush
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={dialogSecondaryButton}>
            取消
          </button>
          <button
            type="button"
            disabled={busy || selected === undefined || selected === currentFolderId}
            onClick={() => selected !== undefined && onConfirm(selected)}
            className={dialogPrimaryButton}
          >
            {busy ? "移动中..." : "移动到这里"}
          </button>
        </>
      }
    >
      <div className="sticky top-0 z-[1] border-b border-slate-100 bg-white px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索目标文件夹"
            className={`${dialogInput} pl-9`}
          />
        </div>
        {error && <div className="mt-2 text-xs font-medium text-rose-600">{error}</div>}
      </div>
      <div className="px-2 py-2">
        {loading ? (
          <div className="px-3 py-10 text-center text-sm text-slate-400">正在加载文件夹...</div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-slate-400">没有可写入的目标文件夹</div>
        ) : (
          visible.map((target) => {
            const isCurrent = target.id === currentFolderId;
            const isSelected = selected === target.id;
            return (
              <button
                key={target.id ?? "root"}
                type="button"
                disabled={isCurrent}
                onClick={() => setSelected(target.id)}
                onDoubleClick={() => !isCurrent && onConfirm(target.id)}
                className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition md:min-h-10 ${
                  isSelected
                    ? "bg-sky-50 text-sky-900 ring-1 ring-sky-200"
                    : "text-slate-700 hover:bg-slate-50"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {target.id === null ? (
                  <Home className="h-5 w-5 shrink-0 text-slate-400" />
                ) : (
                  <FolderIcon className="h-5 w-5 shrink-0 fill-amber-300 text-amber-500" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{target.name}</span>
                  {target.path && target.path !== target.name && (
                    <span className="block truncate text-xs text-slate-400">{target.path}</span>
                  )}
                </span>
                {isCurrent ? (
                  <span className="shrink-0 text-xs text-slate-400">当前位置</span>
                ) : (
                  isSelected && <Check className="h-4 w-4 shrink-0 text-sky-600" />
                )}
              </button>
            );
          })
        )}
      </div>
    </ResponsiveDialog>
  );
}
