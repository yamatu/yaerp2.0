"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { FolderOption } from "@/types";

interface FolderComboboxProps {
  folders: FolderOption[];
  value?: number;
  onChange: (folderID?: number) => void;
  onCreateFolder?: (name: string, parentID?: number) => Promise<number>;
}

export function FolderCombobox({
  folders,
  value,
  onChange,
  onCreateFolder,
}: FolderComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createInSelected, setCreateInSelected] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createError, setCreateError] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const selected = folders.find((folder) => folder.id === value);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return folders;
    return folders.filter((folder) =>
      folder.path.toLocaleLowerCase().includes(keyword),
    );
  }, [folders, query]);

  const beginCreate = () => {
    setCreating(true);
    setCreateInSelected(Boolean(value));
    setNewFolderName(query.trim());
    setCreateError("");
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !onCreateFolder || createLoading) return;
    setCreateLoading(true);
    setCreateError("");
    try {
      const folderID = await onCreateFolder(
        name,
        createInSelected ? value : undefined,
      );
      onChange(folderID);
      setCreating(false);
      setNewFolderName("");
      setQuery("");
      setOpen(false);
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "创建文件夹失败，请稍后重试。",
      );
    } finally {
      setCreateLoading(false);
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setCreating(false);
          setCreateError("");
          setOpen((current) => !current);
        }}
        className="flex h-10 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-left text-sm hover:border-slate-300"
      >
        <Folder className="h-4 w-4 shrink-0 text-sky-600" />
        <span className="min-w-0 flex-1 truncate text-slate-700">
          {selected?.path || "工作台根目录"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-[140] mt-1 w-full min-w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <label className="flex h-10 items-center gap-2 border-b border-slate-200 px-3 text-slate-400">
            <Search className="h-4 w-4" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件夹路径"
              className="min-w-0 flex-1 text-sm text-slate-800 outline-none"
            />
          </label>
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
            >
              <Folder className="h-4 w-4 text-slate-400" />
              <span className="flex-1">工作台根目录</span>
              {!value && <Check className="h-4 w-4 text-emerald-600" />}
            </button>
            {filtered.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => {
                  onChange(folder.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
              >
                <Folder className="h-4 w-4 shrink-0 text-sky-600" />
                <span className="min-w-0 flex-1 truncate">{folder.path}</span>
                {folder.id === value && (
                  <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                )}
              </button>
            ))}
          </div>
          {onCreateFolder && (
            <div className="border-t border-slate-200 p-2">
              {!creating ? (
                <button
                  type="button"
                  onClick={beginCreate}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium text-sky-700 hover:bg-sky-50"
                >
                  <FolderPlus className="h-4 w-4" />
                  新建文件夹
                </button>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createFolder();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="文件夹名称"
                      maxLength={256}
                      autoFocus
                      className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 text-sm text-slate-800 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(false);
                        setCreateError("");
                      }}
                      className="ui-tooltip inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      title="取消新建"
                      aria-label="取消新建文件夹"
                      data-tooltip="取消新建"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {value && selected && (
                    <div className="grid grid-cols-2 rounded-md bg-slate-100 p-1">
                      <button
                        type="button"
                        onClick={() => setCreateInSelected(false)}
                        className={`h-8 rounded text-xs font-medium ${
                          !createInSelected
                            ? "bg-white text-slate-900 shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        根目录
                      </button>
                      <button
                        type="button"
                        onClick={() => setCreateInSelected(true)}
                        className={`h-8 truncate rounded px-2 text-xs font-medium ${
                          createInSelected
                            ? "bg-white text-slate-900 shadow-sm"
                            : "text-slate-500"
                        }`}
                        title={selected.path}
                      >
                        当前目录
                      </button>
                    </div>
                  )}
                  {createError && (
                    <div className="text-xs font-medium text-rose-600">
                      {createError}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={!newFolderName.trim() || createLoading}
                    className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {createLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderPlus className="h-4 w-4" />
                    )}
                    创建并选择
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
