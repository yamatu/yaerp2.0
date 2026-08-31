"use client";

import { useMemo, useState } from "react";
import {
  Boxes,
  Check,
  Loader2,
  PackagePlus,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import api from "@/lib/api";
import type { TradeOrder, TradeOrderItem, TradePackingGroup } from "@/types";

interface PackingGroupDraft {
  key: string;
  length_cm: string;
  width_cm: string;
  height_cm: string;
  weight_kg: string;
  copies: string;
  items: Record<number, string>;
  notes: string;
}

interface PackingGroupsModalProps {
  order: TradeOrder;
  onClose: () => void;
  onSaved: (order: TradeOrder) => void;
  onError: (message: string) => void;
}

function availableQuantity(item: TradeOrderItem) {
  return item.accepted_quantity || item.received_quantity || item.quantity || 0;
}

function groupKey() {
  return `packing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyGroup(order: TradeOrder, includeAll = false): PackingGroupDraft {
  return {
    key: groupKey(),
    length_cm: "",
    width_cm: "",
    height_cm: "",
    weight_kg: "",
    copies: "1",
    items: Object.fromEntries(
      (order.items || []).map((item) => [
        item.id,
        includeAll ? String(availableQuantity(item)) : "",
      ]),
    ),
    notes: "",
  };
}

function draftFromGroup(group: TradePackingGroup): PackingGroupDraft {
  return {
    key: `packing-${group.id}`,
    length_cm: String(group.length_cm || ""),
    width_cm: String(group.width_cm || ""),
    height_cm: String(group.height_cm || ""),
    weight_kg: String(group.weight_kg || ""),
    copies: String(group.copies || 1),
    items: Object.fromEntries(
      (group.items || []).map((item) => [item.order_item_id, String(item.quantity)]),
    ),
    notes: group.notes || "",
  };
}

export function PackingGroupsModal({
  order,
  onClose,
  onSaved,
  onError,
}: PackingGroupsModalProps) {
  const [groups, setGroups] = useState<PackingGroupDraft[]>(() =>
    order.packing_groups?.length
      ? order.packing_groups.map(draftFromGroup)
      : [emptyGroup(order, true)],
  );
  const [saving, setSaving] = useState(false);

  const packedTotals = useMemo(() => {
    const totals: Record<number, number> = {};
    groups.forEach((group) => {
      const copies = Math.max(0, Number(group.copies || 0));
      Object.entries(group.items).forEach(([itemID, quantity]) => {
        totals[Number(itemID)] =
          (totals[Number(itemID)] || 0) + Number(quantity || 0) * copies;
      });
    });
    return totals;
  }, [groups]);

  const updateGroup = (
    key: string,
    update: (group: PackingGroupDraft) => PackingGroupDraft,
  ) => {
    setGroups((current) =>
      current.map((group) => (group.key === key ? update(group) : group)),
    );
  };

  const save = async () => {
    let payload;
    try {
      payload = groups.map((group, index) => {
        const items = Object.entries(group.items)
          .filter(([, quantity]) => Number(quantity) > 0)
          .map(([orderItemID, quantity]) => ({
            order_item_id: Number(orderItemID),
            quantity: Number(quantity),
          }));
        if (items.length === 0) {
          throw new Error(`第 ${index + 1} 个箱组至少需要选择一个产品。`);
        }
        if (
          Number(group.length_cm) <= 0 ||
          Number(group.width_cm) <= 0 ||
          Number(group.height_cm) <= 0 ||
          Number(group.weight_kg) <= 0
        ) {
          throw new Error(
            `第 ${index + 1} 个箱组请填写有效的长、宽、高和实重。`,
          );
        }
        return {
          length_cm: Number(group.length_cm),
          width_cm: Number(group.width_cm),
          height_cm: Number(group.height_cm),
          weight_kg: Number(group.weight_kg),
          copies: Math.max(1, Math.round(Number(group.copies || 1))),
          items,
          notes: group.notes.trim(),
        };
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : "装箱数据不完整");
      return;
    }

    setSaving(true);
    onError("");
    try {
      const response = await api.put<TradeOrder>(
        `/trade/orders/${order.id}/packing-groups`,
        { groups: payload },
      );
      if (response.code !== 0 || !response.data) {
        throw new Error(response.message || "保存装箱组合失败");
      }
      onSaved(response.data);
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存装箱组合失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[96] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div className="flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Boxes className="h-4 w-4 text-orange-600" />
              编辑装箱组合
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              每个箱组代表一种相同装法。勾选同箱 SKU，填写每箱数量和箱数，系统自动汇总装箱数量并计算抛重。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="space-y-4">
            {groups.map((group, groupIndex) => {
              const volumetric =
                (Number(group.length_cm || 0) *
                  Number(group.width_cm || 0) *
                  Number(group.height_cm || 0)) /
                5000;
              return (
                <section
                  key={group.key}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50/50"
                >
                  <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2.5 sm:px-4">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-orange-50 text-xs font-bold text-orange-700">
                        {groupIndex + 1}
                      </span>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          第 {groupIndex + 1} 种装箱方式
                        </div>
                        <div className="text-[11px] text-slate-400">
                          抛重 {volumetric > 0 ? volumetric.toFixed(2) : "0.00"} kg / 箱
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setGroups((current) =>
                          current.length === 1
                            ? [emptyGroup(order)]
                            : current.filter((item) => item.key !== group.key),
                        )
                      }
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50"
                      title="删除这个箱组"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="p-3 sm:p-4">
                    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                      {[
                        ["length_cm", "长 / cm"],
                        ["width_cm", "宽 / cm"],
                        ["height_cm", "高 / cm"],
                        ["weight_kg", "实重 / kg"],
                        ["copies", "相同箱数"],
                      ].map(([key, label]) => (
                        <label key={key} className="block">
                          <span className="mb-1.5 block text-xs font-medium text-slate-600">
                            {label}
                          </span>
                          <input
                            type="number"
                            min={key === "copies" ? 1 : 0}
                            step={key === "copies" ? 1 : "any"}
                            value={group[key as keyof PackingGroupDraft] as string}
                            onChange={(event) =>
                              updateGroup(group.key, (current) => ({
                                ...current,
                                [key]: event.target.value,
                              }))
                            }
                            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                          />
                        </label>
                      ))}
                    </div>

                    <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
                      <div className="grid grid-cols-[minmax(0,1fr)_110px_110px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-500">
                        <span>同箱产品</span>
                        <span className="text-right">每箱数量</span>
                        <span className="text-right">累计装箱</span>
                      </div>
                      {(order.items || []).map((item) => {
                        const selected = Number(group.items[item.id] || 0) > 0;
                        const quantity = Number(group.items[item.id] || 0);
                        const available = availableQuantity(item);
                        return (
                          <div
                            key={item.id}
                            className="grid grid-cols-[minmax(0,1fr)_110px_110px] items-center gap-2 border-t border-slate-100 px-3 py-2 first:border-t-0"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                updateGroup(group.key, (current) => ({
                                  ...current,
                                  items: {
                                    ...current.items,
                                    [item.id]: selected ? "" : String(available),
                                  },
                                }))
                              }
                              className="flex min-w-0 items-center gap-2 text-left"
                            >
                              <span
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? "border-orange-600 bg-orange-600 text-white" : "border-slate-300 bg-white"}`}
                              >
                                {selected && <Check className="h-3 w-3" />}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-semibold text-slate-700">
                                  {item.line_no}. {item.sku || item.product_name}
                                </span>
                                <span className="block truncate text-[11px] text-slate-400">
                                  {item.product_name} · 可装 {available} {item.unit}
                                </span>
                              </span>
                            </button>
                            <input
                              type="number"
                              min={0}
                              max={available}
                              step="any"
                              disabled={!selected}
                              value={selected ? group.items[item.id] || "" : ""}
                              onChange={(event) =>
                                updateGroup(group.key, (current) => ({
                                  ...current,
                                  items: {
                                    ...current.items,
                                    [item.id]: event.target.value,
                                  },
                                }))
                              }
                              className="h-8 w-full rounded-md border border-slate-200 px-2 text-right text-xs disabled:bg-slate-50"
                            />
                            <span
                              className={`text-right text-xs tabular-nums ${(packedTotals[item.id] || 0) > available ? "font-semibold text-rose-600" : "text-slate-500"}`}
                            >
                              {quantity * Math.max(1, Number(group.copies || 1))}
                              <span className="text-slate-300"> / {available}</span>
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <label className="mt-3 block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        装箱备注
                      </span>
                      <input
                        value={group.notes}
                        onChange={(event) =>
                          updateGroup(group.key, (current) => ({
                            ...current,
                            notes: event.target.value,
                          }))
                        }
                        placeholder="例如混装顺序、缓冲材料或贴标要求"
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none"
                      />
                    </label>
                  </div>
                </section>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setGroups((current) => [...current, emptyGroup(order)])}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-orange-200 bg-white px-3 text-sm font-semibold text-orange-700 hover:bg-orange-50"
          >
            <Plus className="h-4 w-4" />
            添加另一种装箱方式
          </button>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
          <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
            <PackagePlus className="h-4 w-4" />
            保存后会同步更新每个产品的装箱数量和标签份数
          </div>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存装箱组合
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
