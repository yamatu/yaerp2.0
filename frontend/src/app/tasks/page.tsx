"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  Inbox,
  Loader2,
  RefreshCw,
  ScrollText,
  ThumbsDown,
  ThumbsUp,
  UserRound,
  Workflow,
  X,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import api from "@/lib/api";
import { wsClient } from "@/lib/ws";
import type {
  ApprovalRequest,
  AutomationRun,
  AutomationRunDetail,
  PageData,
  TaskCenterSummary,
  UserNotification,
} from "@/types";

type TaskTab = "sheetApprovals" | "erpTasks" | "notifications" | "runs";

const statusLabels: Record<string, string> = {
  running: "执行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  rejected: "已拒绝",
  failed: "失败",
  cancelled: "已取消",
  queued: "排队中",
  pending: "待审批",
  approved: "已通过",
};

const statusStyles: Record<string, string> = {
  running: "bg-sky-50 text-sky-700",
  waiting_approval: "bg-amber-50 text-amber-700",
  completed: "bg-emerald-50 text-emerald-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-rose-50 text-rose-700",
  failed: "bg-rose-50 text-rose-700",
  cancelled: "bg-slate-100 text-slate-600",
  queued: "bg-slate-100 text-slate-600",
  pending: "bg-amber-50 text-amber-700",
};

function formatTime(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function rowLabel(run?: AutomationRun) {
  return run?.row_index === undefined ? "" : `第 ${run.row_index + 2} 行`;
}

function formatApprovalValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "空";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function approvalFieldLabel(run: AutomationRun, key: string) {
  return run.trigger_context.field_labels?.[key] || key;
}

function isERPNotification(notification: UserNotification) {
  return (
    notification.notification_type === "trade_workflow" ||
    notification.entity_type === "trade_order"
  );
}

function ApprovalContent({
  run,
  compact = false,
}: {
  run: AutomationRun;
  compact?: boolean;
}) {
  const pendingChanges = run.trigger_context.pending_changes || [];
  const fallbackChanges =
    pendingChanges.length === 0
      ? Object.entries(run.trigger_context.changed_values || {}).map(
          ([col, proposed_value]) => ({
            col,
            proposed_value,
            original_value: undefined,
          }),
        )
      : pendingChanges;
  const changedKeys = new Set(fallbackChanges.map((item) => item.col));
  const relatedEntries = Object.entries(run.trigger_context.row_data || {})
    .filter(
      ([key, value]) =>
        !changedKeys.has(key) &&
        value !== null &&
        value !== undefined &&
        value !== "",
    )
    .slice(0, compact ? 6 : 12);
  if (fallbackChanges.length === 0 && relatedEntries.length === 0) return null;

  return (
    <div className="mt-3 border-l-2 border-amber-300 bg-amber-50/60 px-3 py-2.5">
      <div className="text-xs font-semibold text-amber-900">具体审批内容</div>
      {fallbackChanges.length > 0 && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {fallbackChanges.map((change, index) => (
            <div key={`${change.col}-${index}`} className="min-w-0">
              <div className="truncate text-xs font-semibold text-slate-700">
                {approvalFieldLabel(run, change.col)}
                {run.row_index !== undefined
                  ? ` · 第 ${run.row_index + 2} 行`
                  : ""}
              </div>
              <div className="mt-1 text-xs leading-5 text-slate-600">
                <span className="text-slate-400">原值：</span>
                {formatApprovalValue(change.original_value)}
                <span className="mx-1.5 text-amber-400">→</span>
                <span className="text-slate-400">待审值：</span>
                <strong className="text-amber-800">
                  {formatApprovalValue(change.proposed_value)}
                </strong>
              </div>
            </div>
          ))}
        </div>
      )}
      {relatedEntries.length > 0 && (
        <div className="mt-2 border-t border-amber-100 pt-2">
          <div className="mb-1 text-[11px] font-semibold text-slate-500">
            关联业务信息
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {relatedEntries.map(([key, value]) => (
              <span key={key}>
                <span className="text-slate-400">
                  {approvalFieldLabel(run, key)}：
                </span>
                {formatApprovalValue(value)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCenterContent() {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const requestedRunId = Number(searchParams.get("run") || 0);
  const initialTab: TaskTab =
    requestedTab === "approvals"
      ? "sheetApprovals"
      : requestedTab &&
          ["sheetApprovals", "erpTasks", "notifications", "runs"].includes(
            requestedTab,
          )
        ? (requestedTab as TaskTab)
        : "sheetApprovals";
  const [tab, setTab] = useState<TaskTab>(initialTab);
  const [summary, setSummary] = useState<TaskCenterSummary>({
    pending_approvals: 0,
    unread_erp_tasks: 0,
    unread_system_notifications: 0,
    unread_notifications: 0,
  });
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [decisionTarget, setDecisionTarget] = useState<{
    request: ApprovalRequest;
    decision: "approve" | "reject";
  } | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const pageSize = 20;

  const loadSummary = useCallback(async () => {
    const response = await api.get<TaskCenterSummary>("/tasks/summary");
    if (response.code === 0 && response.data) setSummary(response.data);
  }, []);

  const loadCurrentTab = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        if (tab === "sheetApprovals") {
          const response = await api.get<PageData<ApprovalRequest>>(
            `/tasks/approvals?page=${page}&size=${pageSize}`,
          );
          if (response.code !== 0 || !response.data)
            throw new Error(response.message);
          setApprovals(response.data.list);
          setTotal(response.data.total);
        } else if (tab === "erpTasks" || tab === "notifications") {
          const category = tab === "erpTasks" ? "erp" : "system";
          const response = await api.get<PageData<UserNotification>>(
            `/tasks/notifications?category=${category}&page=${page}&size=${pageSize}`,
          );
          if (response.code !== 0 || !response.data)
            throw new Error(response.message);
          setNotifications(response.data.list);
          setTotal(response.data.total);
        } else {
          const response = await api.get<PageData<AutomationRun>>(
            `/automation/runs?page=${page}&size=${pageSize}`,
          );
          if (response.code !== 0 || !response.data)
            throw new Error(response.message);
          setRuns(response.data.list);
          setTotal(response.data.total);
        }
        await loadSummary();
      } catch (loadError) {
        setError(
          loadError instanceof Error && loadError.message
            ? loadError.message
            : "加载任务失败",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [loadSummary, page, tab],
  );

  const openRunDetail = useCallback(async (runId: number) => {
    if (!runId) return;
    setDetailLoading(true);
    const response = await api.get<AutomationRunDetail>(
      `/automation/runs/${runId}`,
    );
    setDetailLoading(false);
    if (response.code === 0 && response.data) setDetail(response.data);
    else setError(response.message || "加载运行详情失败");
  }, []);

  useEffect(() => {
    void loadCurrentTab();
  }, [loadCurrentTab]);

  useEffect(() => {
    if (requestedRunId > 0) void openRunDetail(requestedRunId);
  }, [openRunDetail, requestedRunId]);

  useEffect(() => {
    wsClient.connect();
    const unsubscribe = wsClient.on("task_notification", () => {
      void loadSummary();
      void loadCurrentTab(true);
    });
    return () => unsubscribe();
  }, [loadCurrentTab, loadSummary]);

  const switchTab = (next: TaskTab) => {
    setTab(next);
    setPage(1);
    setTotal(0);
  };

  const submitDecision = async () => {
    if (!decisionTarget || submitting) return;
    setSubmitting(true);
    const response = await api.post(
      `/tasks/approvals/${decisionTarget.request.id}/decision`,
      {
        decision: decisionTarget.decision,
        comment: comment.trim(),
      },
    );
    setSubmitting(false);
    if (response.code !== 0) {
      setError(response.message || "提交审批失败");
      return;
    }
    setDecisionTarget(null);
    setComment("");
    await loadCurrentTab(true);
  };

  const markRead = async (notification: UserNotification, openLink = false) => {
    if (!notification.read_at) {
      const response = await api.put(
        `/tasks/notifications/${notification.id}/read`,
      );
      if (response.code === 0) {
        setNotifications((current) =>
          current.map((item) =>
            item.id === notification.id
              ? { ...item, read_at: new Date().toISOString() }
              : item,
          ),
        );
        void loadSummary();
      }
    }
    if (
      notification.entity_type === "automation_run" &&
      notification.entity_id
    ) {
      void openRunDetail(notification.entity_id);
    } else if (openLink && notification.link_url) {
      window.location.href = notification.link_url;
    }
  };

  const markAllRead = async () => {
    const category = tab === "erpTasks" ? "erp" : "system";
    const response = await api.put(
      `/tasks/notifications/read-all?category=${category}`,
    );
    if (response.code !== 0) {
      setError(response.message || "操作失败");
      return;
    }
    const readAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) => ({ ...item, read_at: item.read_at || readAt })),
    );
    await loadSummary();
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const tabs = useMemo(
    () => [
      {
        id: "sheetApprovals" as const,
        label: "表格审批",
        icon: FileSpreadsheet,
        count: summary.pending_approvals,
      },
      {
        id: "erpTasks" as const,
        label: "ERP 流程任务",
        icon: BriefcaseBusiness,
        count: summary.unread_erp_tasks,
      },
      {
        id: "notifications" as const,
        label: "系统通知",
        icon: Bell,
        count: summary.unread_system_notifications,
      },
      { id: "runs" as const, label: "自动化记录", icon: ScrollText, count: 0 },
    ],
    [summary],
  );

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100 p-3 md:p-5">
        <div className="mx-auto max-w-6xl space-y-3">
          <header className="rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm md:px-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Link
                  href="/"
                  className="ui-tooltip inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                  title="返回工作台"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                  <Inbox className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-slate-950">
                    任务中心
                  </h1>
                  <p className="mt-0.5 truncate text-sm text-slate-500">
                    表格审批、ERP 交接任务和自动化记录分区处理
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadCurrentTab(true)}
                disabled={refreshing}
                className="inline-flex h-9 items-center gap-2 self-start rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                />
                刷新
              </button>
            </div>
            <nav className="mt-4 flex gap-1 overflow-x-auto border-t border-slate-100 pt-3 [scrollbar-width:none]">
              {tabs.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => switchTab(item.id)}
                    className={`relative inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium ${tab === item.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                    {item.count > 0 && (
                      <span
                        className={`flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] ${tab === item.id ? "bg-white text-slate-900" : "bg-rose-500 text-white"}`}
                      >
                        {item.count > 99 ? "99+" : item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </header>

          {error && (
            <div className="flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <span>{error}</span>
              <button type="button" onClick={() => setError("")}>
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {(tab === "erpTasks" || tab === "notifications") &&
              notifications.some((item) => !item.read_at) && (
                <div className="flex justify-end border-b border-slate-100 px-4 py-2">
                  <button
                    type="button"
                    onClick={() => void markAllRead()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    本分类全部已读
                  </button>
                </div>
              )}
            {loading ? (
              <div className="flex h-72 items-center justify-center text-sm text-slate-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在加载任务...
              </div>
            ) : tab === "sheetApprovals" ? (
              approvals.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="暂无待审批任务"
                  description="新的审批任务会实时出现在这里。"
                />
              ) : (
                <div className="divide-y divide-slate-100">
                  {approvals.map((approval) => (
                    <article key={approval.id} className="p-4 md:p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                          <Workflow className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-sm font-semibold text-slate-900">
                              {approval.rule_name}
                            </h2>
                            <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                              {approval.name}
                            </span>
                          </div>
                          <p className="mt-2 text-sm text-slate-600">
                            需要 {approval.required_approvals}{" "}
                            人通过，当前已通过 {approval.approved_count} 人。
                          </p>
                          {approval.run && (
                            <>
                              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                                {approval.run.workbook_name && (
                                  <span className="inline-flex items-center gap-1">
                                    <FileSpreadsheet className="h-3.5 w-3.5" />
                                    {approval.run.workbook_name} /{" "}
                                    {approval.run.sheet_name}
                                    {rowLabel(approval.run)
                                      ? ` · ${rowLabel(approval.run)}`
                                      : ""}
                                  </span>
                                )}
                                {approval.run.triggered_by_name && (
                                  <span className="inline-flex items-center gap-1">
                                    <UserRound className="h-3.5 w-3.5" />
                                    {approval.run.triggered_by_name}
                                  </span>
                                )}
                                <span className="inline-flex items-center gap-1">
                                  <Clock3 className="h-3.5 w-3.5" />
                                  {formatTime(
                                    approval.activated_at ||
                                      approval.created_at,
                                  )}
                                </span>
                              </div>
                              <ApprovalContent run={approval.run} compact />
                            </>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setDecisionTarget({
                                request: approval,
                                decision: "reject",
                              });
                              setComment("");
                            }}
                            className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-rose-200 px-3 text-sm font-medium text-rose-600 hover:bg-rose-50 lg:flex-none"
                          >
                            <ThumbsDown className="h-4 w-4" />
                            拒绝
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDecisionTarget({
                                request: approval,
                                decision: "approve",
                              });
                              setComment("");
                            }}
                            className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white hover:bg-emerald-700 lg:flex-none"
                          >
                            <ThumbsUp className="h-4 w-4" />
                            通过
                          </button>
                          <button
                            type="button"
                            onClick={() => void openRunDetail(approval.run_id)}
                            className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                            title="查看详情"
                          >
                            <ScrollText className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )
            ) : tab === "erpTasks" || tab === "notifications" ? (
              <NotificationList
                notifications={notifications}
                erpMode={tab === "erpTasks"}
                onOpen={markRead}
              />
            ) : runs.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="暂无运行记录"
                description="可查看由你触发、负责或参与审批的流程。"
              />
            ) : (
              <div className="divide-y divide-slate-100">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => void openRunDetail(run.id)}
                    className="flex w-full flex-col gap-3 px-4 py-4 text-left hover:bg-slate-50 sm:flex-row sm:items-center md:px-5"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                      <Workflow className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-semibold text-slate-900">
                        {run.rule_name}
                      </h2>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                        {run.workbook_name && (
                          <span>
                            {run.workbook_name} / {run.sheet_name}
                            {rowLabel(run) ? ` · ${rowLabel(run)}` : ""}
                          </span>
                        )}
                        <span>{formatTime(run.created_at)}</span>
                        {run.triggered_by_name && (
                          <span>触发人：{run.triggered_by_name}</span>
                        )}
                      </div>
                      {run.error_message && (
                        <p className="mt-2 text-xs text-rose-600">
                          {run.error_message}
                        </p>
                      )}
                    </div>
                    <span
                      className={`self-start rounded-md px-2 py-1 text-xs font-semibold ${statusStyles[run.status] || statusStyles.cancelled}`}
                    >
                      {statusLabels[run.status] || run.status}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {!loading && total > 0 && (
              <footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                <span>
                  第 {page} / {totalPages} 页，共 {total} 条
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={page <= 1}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    上一页
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPage((value) => Math.min(totalPages, value + 1))
                    }
                    disabled={page >= totalPages}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 disabled:opacity-40"
                  >
                    下一页
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </footer>
            )}
          </section>
        </div>

        {decisionTarget && (
          <div
            className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/35 p-0 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !submitting)
                setDecisionTarget(null);
            }}
          >
            <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-lg bg-white p-4 shadow-2xl sm:max-w-lg sm:rounded-lg sm:p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-semibold text-slate-950">
                    {decisionTarget.decision === "approve"
                      ? "通过审批"
                      : "拒绝审批"}
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    {decisionTarget.request.rule_name} ·{" "}
                    {decisionTarget.request.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDecisionTarget(null)}
                  disabled={submitting}
                  className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {decisionTarget.request.run && (
                <ApprovalContent run={decisionTarget.request.run} />
              )}
              <label className="mt-4 block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600">
                  审批意见（选填）
                </span>
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={1000}
                  rows={4}
                  placeholder="说明通过或拒绝原因"
                  className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                />
              </label>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDecisionTarget(null)}
                  disabled={submitting}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void submitDecision()}
                  disabled={submitting}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50 ${decisionTarget.decision === "approve" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"}`}
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  确认{decisionTarget.decision === "approve" ? "通过" : "拒绝"}
                </button>
              </div>
            </div>
          </div>
        )}

        {(detail || detailLoading) && (
          <RunDetailDialog
            detail={detail}
            loading={detailLoading}
            onClose={() => setDetail(null)}
          />
        )}
      </div>
    </AuthGuard>
  );
}

function NotificationList({
  notifications,
  erpMode,
  onOpen,
}: {
  notifications: UserNotification[];
  erpMode: boolean;
  onOpen: (notification: UserNotification, openLink?: boolean) => Promise<void>;
}) {
  if (notifications.length === 0) {
    return erpMode ? (
      <EmptyState
        icon={BriefcaseBusiness}
        title="暂无 ERP 流程任务"
        description="订单进入你的岗位后，会作为独立任务显示在这里。"
      />
    ) : (
      <EmptyState
        icon={Bell}
        title="暂无系统通知"
        description="自动化提醒和系统消息会显示在这里。"
      />
    );
  }
  return (
    <div className="divide-y divide-slate-100">
      {notifications.map((notification) => {
        const erp = isERPNotification(notification);
        const Icon = erp ? BriefcaseBusiness : Bell;
        return (
          <button
            key={notification.id}
            type="button"
            onClick={() => void onOpen(notification, true)}
            className={`flex w-full gap-3 px-4 py-4 text-left hover:bg-slate-50 md:px-5 ${notification.read_at ? "" : erp ? "bg-emerald-50/60" : "bg-sky-50/50"}`}
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${erp ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  {notification.title}
                </h2>
                <span
                  className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${erp ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}
                >
                  {erp
                    ? "ERP 流程任务"
                    : notification.notification_type === "approval"
                      ? "审批通知"
                      : "系统通知"}
                </span>
                {!notification.read_at && (
                  <span
                    className={`h-2 w-2 rounded-full ${erp ? "bg-emerald-500" : "bg-sky-500"}`}
                  />
                )}
              </div>
              {notification.content && (
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  {notification.content}
                </p>
              )}
              <p className="mt-2 text-xs text-slate-400">
                {formatTime(notification.created_at)}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Bell;
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-72 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
        <Icon className="h-5 w-5" />
      </div>
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <p className="mt-1 text-sm text-slate-400">{description}</p>
    </div>
  );
}

function RunDetailDialog({
  detail,
  loading,
  onClose,
}: {
  detail: AutomationRunDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/35 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-lg bg-white shadow-2xl sm:max-w-2xl sm:rounded-lg">
        {loading && !detail ? (
          <div className="flex h-56 items-center justify-center text-sm text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载详情
          </div>
        ) : (
          detail && (
            <>
              <header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white px-4 py-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-950">
                    {detail.run.rule_name}
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    运行 #{detail.run.id} · {formatTime(detail.run.created_at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>
              <div className="space-y-5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md px-2 py-1 text-xs font-semibold ${statusStyles[detail.run.status]}`}
                  >
                    {statusLabels[detail.run.status]}
                  </span>
                  {detail.run.workbook_name && (
                    <span className="text-sm text-slate-500">
                      {detail.run.workbook_name} / {detail.run.sheet_name}
                      {rowLabel(detail.run) ? ` · ${rowLabel(detail.run)}` : ""}
                    </span>
                  )}
                </div>
                {detail.run.error_message && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    {detail.run.error_message}
                  </div>
                )}
                <ApprovalContent run={detail.run} />
                {detail.approvals.length > 0 && (
                  <section>
                    <h4 className="mb-2 text-sm font-semibold text-slate-800">
                      审批链路
                    </h4>
                    <div className="space-y-2">
                      {detail.approvals.map((approval) => (
                        <div
                          key={approval.id}
                          className="rounded-lg border border-slate-200 p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-slate-800">
                              {approval.step_index + 1}. {approval.name}
                            </span>
                            <span
                              className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${statusStyles[approval.status] || statusStyles.cancelled}`}
                            >
                              {statusLabels[approval.status] || approval.status}
                            </span>
                          </div>
                          <div className="mt-2 space-y-1">
                            {approval.assignees.map((assignee) => (
                              <div
                                key={assignee.user_id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs"
                              >
                                <span className="text-slate-600">
                                  {assignee.username}
                                </span>
                                <span className="text-slate-400">
                                  {statusLabels[assignee.status] ||
                                    assignee.status}
                                  {assignee.comment
                                    ? ` · ${assignee.comment}`
                                    : ""}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <section>
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">
                    执行日志
                  </h4>
                  <div className="space-y-2">
                    {detail.logs.map((log) => (
                      <div
                        key={log.id}
                        className="flex gap-3 rounded-lg bg-slate-50 px-3 py-2"
                      >
                        <CheckCircle2
                          className={`mt-0.5 h-4 w-4 shrink-0 ${log.level === "error" ? "text-rose-500" : log.level === "warning" ? "text-amber-500" : "text-emerald-500"}`}
                        />
                        <div>
                          <div className="text-sm text-slate-700">
                            {log.message || log.event}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-400">
                            {formatTime(log.created_at)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}

export default function TaskCenterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载任务中心...
        </div>
      }
    >
      <TaskCenterContent />
    </Suspense>
  );
}
