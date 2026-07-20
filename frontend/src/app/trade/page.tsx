"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BellRing,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  Download,
  Eye,
  FileText,
  FileSpreadsheet,
  History,
  ImagePlus,
  Images,
  Loader2,
  MessageCircle,
  MessageSquare,
  PackageCheck,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Ship,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Trash2,
  Truck,
  UserPlus,
  Users,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { CurrencySearchEnhancer } from "@/components/trade/CurrencyCombobox";
import { SupplierCombobox } from "@/components/trade/SupplierCombobox";
import { WhatsAppAvatarImage } from "@/components/whatsapp/WhatsAppAvatarImage";
import api from "@/lib/api";
import { getStoredUser, isAdmin } from "@/lib/auth";
import { setReturnTarget } from "@/lib/returnNavigation";
import { matchesWhatsAppChat } from "@/lib/whatsappSearch";
import { wsClient } from "@/lib/ws";
import type {
  TradeCustomer,
  TradeCustomerDeleteRequest,
  TradeCustomerQuoteRound,
  TradeCustomerQuoteStatus,
  TradeAccessProfile,
  TradeBossDashboard,
  TradeDashboard,
  TradeInspectionPhoto,
  TradeOrder,
  TradeOrderItem,
  TradePIProfile,
  TradePosition,
  TradeSettings,
  TradeStage,
  TradeSupplier,
  User,
  WhatsAppAccount,
  WhatsAppChat,
} from "@/types";

interface StageDefinition {
  key: Exclude<TradeStage, "cancelled">;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  color: string;
  background: string;
}

interface CustomerDraft {
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
  create_channel: boolean;
  whatsapp_account_id?: number;
  whatsapp_chat_id: string;
  whatsapp_chat_name: string;
  avatar_url: string;
}

interface OrderItemDraft {
  sku: string;
  product_name: string;
  specification: string;
  quantity: string;
  unit: string;
  target_price: string;
  description: string;
}

interface OrderDraft {
  customer_id: number;
  title: string;
  priority: TradeOrder["priority"];
  quote_deadline: string;
  currency: string;
  destination_country: string;
  destination_port: string;
  payment_method: string;
  notes: string;
  create_workspace: boolean;
  shared_workspace: boolean;
}

interface SupplierDraft {
  name: string;
  company_name: string;
  contact_name: string;
  phone: string;
  email: string;
  whatsapp: string;
  country: string;
  default_currency: string;
  payment_method: string;
  notes: string;
}

interface SupplierQuoteDraft {
  order_item_id: number;
  supplier_id: number;
  currency: string;
  unit_price: string;
  moq: string;
  lead_time_days: string;
  valid_until: string;
  notes: string;
}

interface CustomerQuoteItemDraft {
  order_item_id: number;
  line_no: number;
  sku: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: string;
}

interface CustomerQuoteDraft {
  currency: string;
  exchange_rate_cny: string;
  freight_mode: "customer_forwarder" | "quoted";
  freight_amount: string;
  status: "draft" | "sent";
  customer_feedback: string;
  notes: string;
  items: CustomerQuoteItemDraft[];
}

interface CustomerQuoteStatusDraft {
  quote: TradeCustomerQuoteRound;
  status: Exclude<TradeCustomerQuoteStatus, "draft" | "superseded">;
  customer_feedback: string;
  notes: string;
}

interface StageDataField {
  key: string;
  label: string;
  source: "item" | "workflow";
  type?: "text" | "number" | "date" | "select";
  options?: string[];
}

type StageItemDraft = Record<string, string>;

interface ProfitSettingsDraft {
  additional_cost_amount: string;
  additional_cost_notes: string;
  item_rates: Record<number, string>;
}

interface StageShipmentDraft {
  booking_no: string;
  carrier: string;
  vessel_flight: string;
  etd: string;
  eta: string;
  bl_no: string;
  shipping_status: string;
  actual_freight_currency: string;
  actual_freight_amount: string;
  actual_freight_to_cny_rate: string;
  actual_freight_notes: string;
  notes: string;
}

interface TradePIDraft {
  quote_id: number;
  issue_date: string;
  valid_until: string;
  payment_method: string;
  delivery_terms: string;
  delivery_time: string;
  notes: string;
}

type TradeView = "orders" | "customers" | "suppliers" | "boss";
type SettingsTab = "positions" | "payments" | "pi";

const TRADE_STATE_KEY = "yaerp:trade:workspace-state:v3";

function defaultTradePIProfile(): TradePIProfile {
  return {
    company_name: "YAERP Trading Co., Ltd.",
    address: "",
    contact_name: "",
    phone: "",
    email: "",
    tax_id: "",
    bank_name: "",
    bank_address: "",
    account_name: "YAERP Trading Co., Ltd.",
    account_number: "",
    swift_code: "",
    beneficiary_address: "",
    default_notes:
      "All banking charges outside the beneficiary bank are for the buyer's account.",
  };
}

function formatTradeInputDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTradeMonth(value: string) {
  const [year, month] = value.split("-");
  return `${year}/${Number(month)}`;
}

function tradeDownloadFilename(disposition: string | null, fallback: string) {
  if (!disposition) return fallback;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return utf8;
    }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallback;
}

function triggerTradeDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

const STAGES: StageDefinition[] = [
  {
    key: "inquiry",
    label: "客户询价",
    shortLabel: "询价",
    icon: MessageCircle,
    color: "text-amber-700",
    background: "bg-amber-50",
  },
  {
    key: "supplier_quote",
    label: "供应商询价",
    shortLabel: "供应商",
    icon: Store,
    color: "text-pink-700",
    background: "bg-pink-50",
  },
  {
    key: "quotation",
    label: "对客报价与议价",
    shortLabel: "报价议价",
    icon: CircleDollarSign,
    color: "text-sky-700",
    background: "bg-sky-50",
  },
  {
    key: "purchase",
    label: "采购执行",
    shortLabel: "采购",
    icon: ShoppingCart,
    color: "text-violet-700",
    background: "bg-violet-50",
  },
  {
    key: "receiving",
    label: "仓库到货",
    shortLabel: "到货",
    icon: Warehouse,
    color: "text-cyan-700",
    background: "bg-cyan-50",
  },
  {
    key: "inspection",
    label: "质量检验",
    shortLabel: "质检",
    icon: ClipboardCheck,
    color: "text-teal-700",
    background: "bg-teal-50",
  },
  {
    key: "packing",
    label: "装箱贴标",
    shortLabel: "装箱",
    icon: Boxes,
    color: "text-orange-700",
    background: "bg-orange-50",
  },
  {
    key: "shipment",
    label: "物流发货",
    shortLabel: "发货",
    icon: Ship,
    color: "text-blue-700",
    background: "bg-blue-50",
  },
  {
    key: "completed",
    label: "业务完成",
    shortLabel: "完成",
    icon: PackageCheck,
    color: "text-emerald-700",
    background: "bg-emerald-50",
  },
];

const PRIORITY_LABELS: Record<TradeOrder["priority"], string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};

const SOURCE_LABELS: Record<TradeCustomer["source"], string> = {
  manual: "手工录入",
  whatsapp: "WhatsApp",
  email: "邮件",
  website: "官网",
  exhibition: "展会",
  referral: "客户转介绍",
  marketplace: "电商平台",
  other: "其他",
};

const CUSTOMER_STATUS_LABELS: Record<TradeCustomer["status"], string> = {
  lead: "潜在客户",
  active: "合作中",
  inactive: "暂停合作",
  blocked: "停止合作",
};

function newCustomerDraft(): CustomerDraft {
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
    create_channel: true,
    whatsapp_chat_id: "",
    whatsapp_chat_name: "",
    avatar_url: "",
  };
}

function newOrderItem(): OrderItemDraft {
  return {
    sku: "",
    product_name: "",
    specification: "",
    quantity: "1",
    unit: "件",
    target_price: "",
    description: "",
  };
}

function newOrderDraft(customerId = 0, paymentMethod = "T/T 电汇"): OrderDraft {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 3);
  return {
    customer_id: customerId,
    title: "",
    priority: "normal",
    quote_deadline: deadline.toISOString().slice(0, 10),
    currency: "USD",
    destination_country: "",
    destination_port: "",
    payment_method: paymentMethod,
    notes: "",
    create_workspace: true,
    shared_workspace: true,
  };
}

function newSupplierDraft(paymentMethod = "T/T 电汇"): SupplierDraft {
  return {
    name: "",
    company_name: "",
    contact_name: "",
    phone: "",
    email: "",
    whatsapp: "",
    country: "",
    default_currency: "USD",
    payment_method: paymentMethod,
    notes: "",
  };
}

function newSupplierQuoteDraft(
  order?: TradeOrder,
  suppliers: TradeSupplier[] = [],
): SupplierQuoteDraft {
  return {
    order_item_id: order?.items?.[0]?.id || 0,
    supplier_id: suppliers[0]?.id || 0,
    currency: order?.currency || suppliers[0]?.default_currency || "USD",
    unit_price: "",
    moq: "",
    lead_time_days: "",
    valid_until: "",
    notes: "",
  };
}

function newCustomerQuoteDraft(
  order: TradeOrder,
  source?: TradeCustomerQuoteRound,
): CustomerQuoteDraft {
  return {
    currency: source?.currency || order.currency || "USD",
    exchange_rate_cny:
      (source?.exchange_rate_cny || 0) > 0
        ? String(source?.exchange_rate_cny)
        : order.quote_exchange_rate_cny > 0
          ? String(order.quote_exchange_rate_cny)
          : (source?.currency || order.currency) === "CNY"
            ? "1"
            : "",
    freight_mode:
      source?.freight_mode || order.freight_mode || "customer_forwarder",
    freight_amount:
      (source?.freight_amount || order.quoted_freight_amount || 0) > 0
        ? String(source?.freight_amount || order.quoted_freight_amount)
        : "",
    status: "sent",
    customer_feedback: source?.customer_feedback || "",
    notes: "",
    items: (order.items || []).map((item) => {
      const sourceItem = source?.items.find(
        (candidate) => candidate.order_item_id === item.id,
      );
      const suggestedPrice =
        sourceItem?.unit_price || item.quoted_price || item.purchase_price || 0;
      return {
        order_item_id: item.id,
        line_no: item.line_no,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: suggestedPrice > 0 ? String(suggestedPrice) : "",
      };
    }),
  };
}

const customerQuoteStatusLabels: Record<TradeCustomerQuoteStatus, string> = {
  draft: "草稿",
  sent: "已向客户报价",
  negotiating: "客户议价中",
  accepted: "客户已接受",
  rejected: "客户已拒绝",
  superseded: "已被新报价替代",
};

const customerQuoteStatusStyles: Record<TradeCustomerQuoteStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-sky-50 text-sky-700",
  negotiating: "bg-amber-50 text-amber-700",
  accepted: "bg-emerald-50 text-emerald-700",
  rejected: "bg-rose-50 text-rose-700",
  superseded: "bg-slate-100 text-slate-400",
};

const STAGE_DATA_FIELDS: Partial<Record<TradeStage, StageDataField[]>> = {
  inquiry: [
    { key: "sku", label: "SKU", source: "item" },
    { key: "product_name", label: "产品名称", source: "item" },
    { key: "specification", label: "规格", source: "item" },
    { key: "quantity", label: "数量", source: "item", type: "number" },
    { key: "unit", label: "单位", source: "item" },
    { key: "target_price", label: "目标价", source: "item", type: "number" },
    { key: "description", label: "客户要求", source: "item" },
    {
      key: "status",
      label: "询价状态",
      source: "item",
      type: "select",
      options: ["待询价", "已询价", "无法报价"],
    },
  ],
  purchase: [
    { key: "supplier_name", label: "供应商", source: "item" },
    { key: "purchase_currency", label: "采购币种", source: "item" },
    { key: "purchase_price", label: "采购价", source: "item", type: "number" },
    {
      key: "cost_exchange_rate",
      label: "成本换算率",
      source: "workflow",
      type: "number",
    },
    {
      key: "purchase_status",
      label: "采购状态",
      source: "workflow",
      type: "select",
      options: ["待采购", "询价中", "已下单", "生产中", "已完成"],
    },
  ],
  receiving: [
    {
      key: "received_quantity",
      label: "实到数量",
      source: "item",
      type: "number",
    },
    { key: "warehouse_location", label: "库位", source: "workflow" },
    {
      key: "received_date",
      label: "到货日期",
      source: "workflow",
      type: "date",
    },
    {
      key: "receipt_status",
      label: "到货状态",
      source: "workflow",
      type: "select",
      options: ["待到货", "部分到货", "全部到货", "数量异常"],
    },
  ],
  inspection: [
    {
      key: "sample_qty",
      label: "抽检数量",
      source: "workflow",
      type: "number",
    },
    {
      key: "accepted_quantity",
      label: "合格数量",
      source: "item",
      type: "number",
    },
    {
      key: "inspection_result",
      label: "质检结论",
      source: "workflow",
      type: "select",
      options: ["待检", "合格", "返工", "拒收"],
    },
    { key: "inspection_issue", label: "问题描述", source: "workflow" },
    { key: "inspector", label: "质检员", source: "workflow" },
    {
      key: "inspection_date",
      label: "质检日期",
      source: "workflow",
      type: "date",
    },
  ],
  packing: [
    { key: "carton_no", label: "箱号", source: "workflow" },
    {
      key: "packed_quantity",
      label: "装箱数量",
      source: "item",
      type: "number",
    },
    { key: "carton_count", label: "箱数", source: "item", type: "number" },
    { key: "carton_size", label: "箱规", source: "workflow" },
    { key: "gross_weight", label: "毛重/kg", source: "item", type: "number" },
    { key: "net_weight", label: "净重/kg", source: "item", type: "number" },
    { key: "hs_code", label: "HS Code", source: "item" },
    { key: "marks", label: "唛头", source: "workflow" },
  ],
};

const SHIPMENT_STATUSES = [
  "待订舱",
  "已订舱",
  "已装柜",
  "已离港",
  "运输中",
  "已到港",
  "已签收",
];

function emptyStageShipmentDraft(order?: TradeOrder): StageShipmentDraft {
  return {
    booking_no: order?.shipment?.booking_no || "",
    carrier: order?.shipment?.carrier || "",
    vessel_flight: order?.shipment?.vessel_flight || "",
    etd: order?.shipment?.etd?.slice(0, 10) || "",
    eta: order?.shipment?.eta?.slice(0, 10) || "",
    bl_no: order?.shipment?.bl_no || "",
    shipping_status: order?.shipment?.shipping_status || "待订舱",
    actual_freight_currency: order?.shipment?.actual_freight_currency || "CNY",
    actual_freight_amount:
      (order?.shipment?.actual_freight_amount || 0) > 0
        ? String(order?.shipment?.actual_freight_amount)
        : "",
    actual_freight_to_cny_rate:
      (order?.shipment?.actual_freight_to_cny_rate || 0) > 0
        ? String(order?.shipment?.actual_freight_to_cny_rate)
        : "1",
    actual_freight_notes: order?.shipment?.actual_freight_notes || "",
    notes: order?.shipment?.notes || "",
  };
}

function stageItemValue(item: TradeOrderItem, field: StageDataField) {
  const value =
    field.source === "workflow"
      ? item.workflow_data?.[field.key]
      : item[field.key as keyof TradeOrderItem];
  return value === null || value === undefined ? "" : String(value);
}

function stageItemStatus(stage: TradeStage, item: TradeOrderItem) {
  const workflow = item.workflow_data || {};
  switch (stage) {
    case "inquiry":
      return item.status === "pending" ? "待询价" : item.status || "待询价";
    case "supplier_quote":
      return item.supplier_name ? "已采用供应商" : "待供应商报价";
    case "quotation":
      return item.quoted_price > 0 ? item.status || "已报价" : "待对客报价";
    case "purchase":
      return String(workflow.purchase_status || item.status || "待采购");
    case "receiving":
      return String(workflow.receipt_status || item.status || "待到货");
    case "inspection":
      return String(workflow.inspection_result || item.status || "待检");
    case "packing":
      return item.packed_quantity > 0 ? "装箱中" : "待装箱";
    default:
      return item.status || "-";
  }
}

function stageDefinition(stage: TradeStage) {
  return STAGES.find((item) => item.key === stage);
}

function nextStage(stage: TradeStage): TradeStage | null {
  const index = STAGES.findIndex((item) => item.key === stage);
  if (index < 0 || index + 1 >= STAGES.length) return null;
  return STAGES[index + 1].key;
}

function previousStage(stage: TradeStage): TradeStage | null {
  const index = STAGES.findIndex((item) => item.key === stage);
  if (index <= 0) return null;
  return STAGES[index - 1].key;
}

function formatDate(value?: string) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

function formatMoney(currency: string, value: number) {
  if (!value) return "-";
  return `${currency} ${value.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}`;
}

function formatFinancialMoney(currency: string, value: number) {
  return `${currency} ${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number) {
  return `${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

function priorityClass(priority: TradeOrder["priority"]) {
  switch (priority) {
    case "urgent":
      return "bg-rose-50 text-rose-700";
    case "high":
      return "bg-orange-50 text-orange-700";
    case "low":
      return "bg-slate-100 text-slate-500";
    default:
      return "bg-sky-50 text-sky-700";
  }
}

function readTradeWorkspaceState() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(
      window.localStorage.getItem(TRADE_STATE_KEY) || "null",
    ) as {
      activeView?: TradeView;
      search?: string;
      stageFilter?: TradeStage | "all";
      showOnlyMine?: boolean;
      ownerFilter?: number | "all";
      customerFilter?: number | "all";
      detailOrderId?: number;
      scrollY?: number;
    } | null;
  } catch {
    return null;
  }
}

export default function TradeWorkspacePage() {
  const router = useRouter();
  const profile = getStoredUser();
  const adminMode = isAdmin(profile);
  const detailOrderIDRef = useRef<number | null>(null);
  const realtimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredRef = useRef(false);
  const [workspaceRestored, setWorkspaceRestored] = useState(false);

  const [dashboard, setDashboard] = useState<TradeDashboard | null>(null);
  const [bossDashboard, setBossDashboard] = useState<TradeBossDashboard | null>(
    null,
  );
  const [tradeAccess, setTradeAccess] = useState<TradeAccessProfile | null>(
    null,
  );
  const [customers, setCustomers] = useState<TradeCustomer[]>([]);
  const [customerDeleteRequests, setCustomerDeleteRequests] = useState<
    TradeCustomerDeleteRequest[]
  >([]);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [suppliers, setSuppliers] = useState<TradeSupplier[]>([]);
  const [positions, setPositions] = useState<TradePosition[]>([]);
  const [settings, setSettings] = useState<TradeSettings>({
    payment_methods: ["T/T 电汇"],
    pi_profile: defaultTradePIProfile(),
  });
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeView, setActiveView] = useState<TradeView>("orders");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<TradeStage | "all">("all");
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState<number | "all">("all");
  const [customerFilter, setCustomerFilter] = useState<number | "all">("all");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] =
    useState<TradeCustomer | null>(null);
  const [customerMode, setCustomerMode] = useState<"manual" | "whatsapp">(
    "manual",
  );
  const [customerDraft, setCustomerDraft] =
    useState<CustomerDraft>(newCustomerDraft);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [customerDeleteTarget, setCustomerDeleteTarget] =
    useState<TradeCustomer | null>(null);
  const [customerDeleteReason, setCustomerDeleteReason] = useState("");
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const [customerDeleteApprovalsOpen, setCustomerDeleteApprovalsOpen] =
    useState(false);
  const [decidingCustomerDeleteID, setDecidingCustomerDeleteID] = useState<
    number | null
  >(null);
  const [whatsAppAccount, setWhatsAppAccount] =
    useState<WhatsAppAccount | null>(null);
  const [whatsAppChats, setWhatsAppChats] = useState<WhatsAppChat[]>([]);
  const [whatsAppLoading, setWhatsAppLoading] = useState(false);
  const [whatsAppSearch, setWhatsAppSearch] = useState("");

  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [orderDraft, setOrderDraft] = useState<OrderDraft>(() =>
    newOrderDraft(),
  );
  const [orderItems, setOrderItems] = useState<OrderItemDraft[]>([
    newOrderItem(),
  ]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [additionalItems, setAdditionalItems] = useState<OrderItemDraft[]>([
    newOrderItem(),
  ]);
  const [savingItems, setSavingItems] = useState(false);

  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>(() =>
    newSupplierDraft(),
  );
  const [savingSupplier, setSavingSupplier] = useState(false);

  const [quoteModalOpen, setQuoteModalOpen] = useState(false);
  const [quoteDraft, setQuoteDraft] = useState<SupplierQuoteDraft>(() =>
    newSupplierQuoteDraft(),
  );
  const [savingQuote, setSavingQuote] = useState(false);
  const [customerQuoteModalOpen, setCustomerQuoteModalOpen] = useState(false);
  const [customerQuoteDraft, setCustomerQuoteDraft] =
    useState<CustomerQuoteDraft | null>(null);
  const [savingCustomerQuote, setSavingCustomerQuote] = useState(false);
  const [customerQuoteStatusDraft, setCustomerQuoteStatusDraft] =
    useState<CustomerQuoteStatusDraft | null>(null);
  const [savingCustomerQuoteStatus, setSavingCustomerQuoteStatus] =
    useState(false);
  const [stageDataModalOpen, setStageDataModalOpen] = useState(false);
  const [stageItemDrafts, setStageItemDrafts] = useState<
    Record<number, StageItemDraft>
  >({});
  const [stageShipmentDraft, setStageShipmentDraft] =
    useState<StageShipmentDraft>(() => emptyStageShipmentDraft());
  const [savingStageData, setSavingStageData] = useState(false);
  const [orderItemDeleteTarget, setOrderItemDeleteTarget] =
    useState<TradeOrderItem | null>(null);
  const [deletingOrderItem, setDeletingOrderItem] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("positions");
  const [positionsDraft, setPositionsDraft] = useState<
    Record<string, number[]>
  >({});
  const [positionUserSearch, setPositionUserSearch] = useState("");
  const [paymentMethodsText, setPaymentMethodsText] = useState("");
  const [piProfileDraft, setPIProfileDraft] = useState<TradePIProfile>(
    defaultTradePIProfile,
  );
  const [savingSettings, setSavingSettings] = useState(false);

  const [detailOrder, setDetailOrder] = useState<TradeOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [flowing, setFlowing] = useState(false);
  const [advanceNote, setAdvanceNote] = useState("");
  const [syncingWorkbook, setSyncingWorkbook] = useState(false);
  const [inspectionItemID, setInspectionItemID] = useState<number | "">("");
  const [inspectionNote, setInspectionNote] = useState("");
  const [inspectionFiles, setInspectionFiles] = useState<File[]>([]);
  const [uploadingInspection, setUploadingInspection] = useState(false);
  const [selectedPhoto, setSelectedPhoto] =
    useState<TradeInspectionPhoto | null>(null);
  const [profitSettingsOpen, setProfitSettingsOpen] = useState(false);
  const [profitSettingsDraft, setProfitSettingsDraft] =
    useState<ProfitSettingsDraft | null>(null);
  const [savingProfitSettings, setSavingProfitSettings] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TradeOrder | null>(null);
  const [deletingOrder, setDeletingOrder] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [piModalOpen, setPIModalOpen] = useState(false);
  const [piDraft, setPIDraft] = useState<TradePIDraft | null>(null);
  const [piPreviewURL, setPIPreviewURL] = useState("");
  const [piAction, setPIAction] = useState<
    "preview" | "download" | "send" | null
  >(null);

  const loadData = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const requests = [
          api.get<TradeAccessProfile>("/trade/access"),
          api.get<TradeDashboard>("/trade/dashboard"),
          api.get<TradeCustomer[]>("/trade/customers"),
          api.get<TradeOrder[]>("/trade/orders"),
          api.get<TradeSupplier[]>("/trade/suppliers"),
          api.get<TradePosition[]>("/trade/positions"),
          api.get<TradeSettings>("/trade/settings"),
          api.get<TradeCustomerDeleteRequest[]>(
            "/trade/customer-delete-requests?status=pending",
          ),
        ] as const;
        const [
          accessResponse,
          dashboardResponse,
          customerResponse,
          orderResponse,
          supplierResponse,
          positionResponse,
          settingsResponse,
          customerDeleteResponse,
        ] = await Promise.all(requests);
        const responses = [
          accessResponse,
          dashboardResponse,
          customerResponse,
          orderResponse,
          supplierResponse,
          positionResponse,
          settingsResponse,
          customerDeleteResponse,
        ];
        const failed = responses.find((response) => response.code !== 0);
        if (failed) throw new Error(failed.message || "加载外贸业务数据失败");
        setTradeAccess(accessResponse.data || null);
        setDashboard(dashboardResponse.data || null);
        setCustomers(customerResponse.data || []);
        setOrders(orderResponse.data || []);
        setSuppliers(supplierResponse.data || []);
        setPositions(positionResponse.data || []);
        setCustomerDeleteRequests(customerDeleteResponse.data || []);
        if (accessResponse.data?.can_view_all_orders) {
          const bossResponse = await api.get<TradeBossDashboard>(
            "/trade/boss-dashboard",
          );
          if (bossResponse.code !== 0)
            throw new Error(bossResponse.message || "加载老板面板失败");
          if (bossResponse.data) {
            setBossDashboard({
              ...bossResponse.data,
              currencies: bossResponse.data.currencies || [],
              monthly: bossResponse.data.monthly || [],
              recent_orders: bossResponse.data.recent_orders || [],
              top_profit_orders: bossResponse.data.top_profit_orders || [],
              loss_orders_list: bossResponse.data.loss_orders_list || [],
            });
          } else {
            setBossDashboard(null);
          }
        } else {
          setBossDashboard(null);
        }
        const loadedSettings = settingsResponse.data || {
          payment_methods: ["T/T 电汇"],
          pi_profile: defaultTradePIProfile(),
        };
        if (!loadedSettings.pi_profile) {
          loadedSettings.pi_profile = defaultTradePIProfile();
        }
        setSettings(loadedSettings);
        setPaymentMethodsText(
          (loadedSettings.payment_methods || []).join("\n"),
        );
        setPIProfileDraft(loadedSettings.pi_profile);
        setPositionsDraft(
          Object.fromEntries(
            (positionResponse.data || []).map((position) => [
              position.code,
              position.members.map((member) => member.user_id),
            ]),
          ),
        );
        if (adminMode) {
          const userResponse = await api.get<User[]>("/users/shareable");
          if (userResponse.code === 0) setUsers(userResponse.data || []);
        }
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "加载外贸业务数据失败",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [adminMode],
  );

  const loadOrderDetail = useCallback(
    async (orderID: number, showLoader = true, silentIfMissing = false) => {
      if (showLoader) setDetailLoading(true);
      try {
        const response = await api.get<TradeOrder>(`/trade/orders/${orderID}`);
        if (response.code !== 0 || !response.data) {
          if (silentIfMissing) {
            setDetailOrder(null);
            detailOrderIDRef.current = null;
            const saved = readTradeWorkspaceState() || {};
            window.localStorage.setItem(
              TRADE_STATE_KEY,
              JSON.stringify({ ...saved, detailOrderId: undefined }),
            );
            return;
          }
          throw new Error(response.message || "加载业务单详情失败");
        }
        setDetailOrder(response.data);
        detailOrderIDRef.current = response.data.id;
        if (!inspectionItemID && response.data.items?.length)
          setInspectionItemID(response.data.items[0].id);
      } catch (detailError) {
        setDetailOrder(null);
        detailOrderIDRef.current = null;
        setError(
          detailError instanceof Error
            ? detailError.message
            : "加载业务单详情失败",
        );
      } finally {
        if (showLoader) setDetailLoading(false);
      }
    },
    [inspectionItemID],
  );

  useEffect(() => {
    const saved = readTradeWorkspaceState();
    if (saved?.activeView) setActiveView(saved.activeView);
    if (typeof saved?.search === "string") setSearch(saved.search);
    if (saved?.stageFilter) setStageFilter(saved.stageFilter);
    if (typeof saved?.showOnlyMine === "boolean")
      setShowOnlyMine(saved.showOnlyMine);
    if (saved?.ownerFilter) setOwnerFilter(saved.ownerFilter);
    if (saved?.customerFilter) setCustomerFilter(saved.customerFilter);
    const queryOrderID = Number(
      new URLSearchParams(window.location.search).get("order"),
    );
    const restoredOrderID =
      Number.isInteger(queryOrderID) && queryOrderID > 0
        ? queryOrderID
        : saved?.detailOrderId;
    if (restoredOrderID) detailOrderIDRef.current = restoredOrderID;
    restoredRef.current = true;
    setWorkspaceRestored(true);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(
    () => () => {
      if (piPreviewURL) window.URL.revokeObjectURL(piPreviewURL);
    },
    [piPreviewURL],
  );

  useEffect(() => {
    if (!tradeAccess) return;
    if (activeView === "customers" && !tradeAccess.can_view_customers)
      setActiveView("orders");
    if (activeView === "suppliers" && !tradeAccess.can_view_suppliers)
      setActiveView("orders");
    if (activeView === "boss" && !tradeAccess.can_view_all_orders)
      setActiveView("orders");
  }, [activeView, tradeAccess]);

  useEffect(() => {
    if (loading || !restoredRef.current) return;
    const orderID = detailOrderIDRef.current;
    if (orderID && !detailOrder) void loadOrderDetail(orderID, true, true);
    const saved = readTradeWorkspaceState();
    if (typeof saved?.scrollY === "number")
      requestAnimationFrame(() => window.scrollTo({ top: saved.scrollY }));
  }, [detailOrder, loadOrderDetail, loading]);

  const persistWorkspaceState = useCallback(() => {
    if (!restoredRef.current || !workspaceRestored) return;
    window.localStorage.setItem(
      TRADE_STATE_KEY,
      JSON.stringify({
        activeView,
        search,
        stageFilter,
        showOnlyMine,
        ownerFilter,
        customerFilter,
        detailOrderId: detailOrderIDRef.current || undefined,
        scrollY: window.scrollY,
      }),
    );
  }, [
    activeView,
    customerFilter,
    ownerFilter,
    search,
    showOnlyMine,
    stageFilter,
    workspaceRestored,
  ]);

  useEffect(() => {
    persistWorkspaceState();
  }, [persistWorkspaceState]);

  useEffect(() => {
    window.addEventListener("pagehide", persistWorkspaceState);
    return () => window.removeEventListener("pagehide", persistWorkspaceState);
  }, [persistWorkspaceState]);

  useEffect(() => {
    wsClient.connect();
    const unsubscribe = wsClient.on("trade_order_updated", (message) => {
      if (realtimeTimerRef.current) clearTimeout(realtimeTimerRef.current);
      realtimeTimerRef.current = setTimeout(() => {
        void loadData(true);
        if (message.orderId && detailOrderIDRef.current === message.orderId)
          void loadOrderDetail(message.orderId, false);
      }, 180);
    });
    return () => {
      unsubscribe();
      if (realtimeTimerRef.current) clearTimeout(realtimeTimerRef.current);
    };
  }, [loadData, loadOrderDetail]);

  const loadWhatsApp = useCallback(async () => {
    setWhatsAppLoading(true);
    setError("");
    try {
      const accountResponse =
        await api.get<WhatsAppAccount>("/whatsapp/account");
      const account =
        accountResponse.code === 0 ? accountResponse.data || null : null;
      setWhatsAppAccount(account);
      if (account?.status !== "ready") {
        setWhatsAppChats([]);
        return;
      }
      const chatsResponse = await api.get<WhatsAppChat[]>("/whatsapp/chats");
      if (chatsResponse.code !== 0)
        throw new Error(chatsResponse.message || "读取 WhatsApp 会话失败");
      setWhatsAppChats(
        (chatsResponse.data || []).filter((chat) => !chat.isGroup),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "读取 WhatsApp 会话失败",
      );
    } finally {
      setWhatsAppLoading(false);
    }
  }, []);

  useEffect(() => {
    if (
      customerModalOpen &&
      customerMode === "whatsapp" &&
      whatsAppChats.length === 0
    )
      void loadWhatsApp();
  }, [customerModalOpen, customerMode, loadWhatsApp, whatsAppChats.length]);

  const filteredOrders = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (showOnlyMine && profile?.id && order.owner_id !== profile.id)
        return false;
      if (ownerFilter !== "all" && order.owner_id !== ownerFilter) return false;
      if (customerFilter !== "all" && order.customer_id !== customerFilter)
        return false;
      if (stageFilter !== "all" && order.stage !== stageFilter) return false;
      if (!keyword) return true;
      return [
        order.order_no,
        order.title,
        order.customer_name,
        order.customer_company,
        order.destination_country,
        order.destination_port,
        order.owner_name,
      ].some((value) => value?.toLowerCase().includes(keyword));
    });
  }, [
    customerFilter,
    orders,
    ownerFilter,
    profile?.id,
    search,
    showOnlyMine,
    stageFilter,
  ]);

  const orderOwners = useMemo(() => {
    const byID = new Map<number, string>();
    orders.forEach((order) => {
      if (order.owner_id > 0) byID.set(order.owner_id, order.owner_name);
    });
    return Array.from(byID, ([id, name]) => ({ id, name })).sort(
      (left, right) => left.name.localeCompare(right.name, "zh-CN"),
    );
  }, [orders]);

  const pendingCustomerDeleteByCustomer = useMemo(
    () =>
      new Map(
        customerDeleteRequests
          .filter((request) => request.status === "pending")
          .map((request) => [request.customer_id, request]),
      ),
    [customerDeleteRequests],
  );

  const filteredCustomers = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return customers.filter((customer) => {
      if (showOnlyMine && profile?.id && customer.owner_id !== profile.id)
        return false;
      if (!keyword) return true;
      return [
        customer.customer_code,
        customer.name,
        customer.company_name,
        customer.contact_name,
        customer.email,
        customer.phone,
        customer.country,
        customer.owner_name,
      ].some((value) => value?.toLowerCase().includes(keyword));
    });
  }, [customers, profile?.id, search, showOnlyMine]);

  const filteredSuppliers = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return suppliers.filter((supplier) => {
      if (showOnlyMine && profile?.id && supplier.owner_id !== profile.id)
        return false;
      if (!keyword) return true;
      return [
        supplier.supplier_code,
        supplier.name,
        supplier.company_name,
        supplier.contact_name,
        supplier.phone,
        supplier.email,
        supplier.whatsapp,
        supplier.country,
      ].some((value) => value?.toLowerCase().includes(keyword));
    });
  }, [profile?.id, search, showOnlyMine, suppliers]);

  const filteredWhatsAppChats = useMemo(
    () =>
      whatsAppChats.filter((chat) => matchesWhatsAppChat(chat, whatsAppSearch)),
    [whatsAppChats, whatsAppSearch],
  );
  const filteredPositionUsers = useMemo(() => {
    const keyword = positionUserSearch.trim().toLowerCase();
    if (!keyword) return users;
    return users.filter((user) =>
      [user.username, user.email].some((value) =>
        value?.toLowerCase().includes(keyword),
      ),
    );
  }, [positionUserSearch, users]);

  const customerQuoteAmounts = useMemo(() => {
    if (!customerQuoteDraft)
      return { goods: 0, freight: 0, total: 0, totalCNY: 0 };
    const goods = customerQuoteDraft.items.reduce(
      (sum, item) => sum + Number(item.unit_price || 0) * item.quantity,
      0,
    );
    const freight =
      customerQuoteDraft.freight_mode === "quoted"
        ? Number(customerQuoteDraft.freight_amount || 0)
        : 0;
    const total = goods + freight;
    return {
      goods,
      freight,
      total,
      totalCNY: total * Number(customerQuoteDraft.exchange_rate_cny || 0),
    };
  }, [customerQuoteDraft]);

  const visibleTimelineEvents = useMemo(() => {
    const events = detailOrder?.events || [];
    if (timelineExpanded || events.length <= 4) return events;
    return events.slice(-4);
  }, [detailOrder?.events, timelineExpanded]);

  const monthlyProfitMax = useMemo(
    () =>
      Math.max(
        1,
        ...(bossDashboard?.monthly || []).flatMap((month) => [
          Math.abs(month.revenue_cny),
          Math.abs(month.total_cost_cny),
          Math.abs(month.profit_amount_cny),
        ]),
      ),
    [bossDashboard?.monthly],
  );

  const selectedPIQuote = useMemo(
    () =>
      (detailOrder?.customer_quotes || []).find(
        (quote) => quote.id === piDraft?.quote_id,
      ) || null,
    [detailOrder?.customer_quotes, piDraft?.quote_id],
  );

  const openCustomerModal = (mode: "manual" | "whatsapp" = "manual") => {
    setEditingCustomer(null);
    setCustomerDraft(newCustomerDraft());
    setCustomerMode(mode);
    setWhatsAppSearch("");
    setCustomerModalOpen(true);
    setError("");
  };

  const openEditCustomer = (customer: TradeCustomer) => {
    setEditingCustomer(customer);
    setCustomerMode("manual");
    setWhatsAppSearch("");
    setCustomerDraft({
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
      create_channel: false,
      whatsapp_account_id: customer.whatsapp_account_id,
      whatsapp_chat_id: customer.whatsapp_chat_id,
      whatsapp_chat_name: customer.whatsapp_chat_name,
      avatar_url: customer.avatar_url,
    });
    setCustomerModalOpen(true);
    setError("");
  };

  const chooseWhatsAppChat = (chat: WhatsAppChat) => {
    const phone = chat.id.split("@")[0].replace(/\D/g, "");
    setCustomerDraft((current) => ({
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

  const saveCustomer = async () => {
    if (!customerDraft.name.trim()) return setError("请输入客户名称。");
    setSavingCustomer(true);
    setError("");
    try {
      const payload = {
        ...customerDraft,
        name: customerDraft.name.trim(),
        company_name: customerDraft.company_name.trim(),
        tags: customerDraft.tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
      const response = editingCustomer
        ? await api.put<TradeCustomer>(
            `/trade/customers/${editingCustomer.id}`,
            payload,
          )
        : await api.post<TradeCustomer>("/trade/customers", payload);
      if (response.code !== 0 || !response.data)
        throw new Error(
          response.message || (editingCustomer ? "更新客户失败" : "创建客户失败"),
        );
      setCustomerModalOpen(false);
      setNotice(
        editingCustomer
          ? `客户「${response.data.name}」资料已更新。`
          : response.data.integration_warning ||
              `客户「${response.data.name}」已建档。内部建档提示不会发送给 WhatsApp 客户。`,
      );
      if (!editingCustomer) {
        setOrderDraft((current) => ({
          ...current,
          customer_id: response.data!.id,
        }));
      }
      setEditingCustomer(null);
      await loadData(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : editingCustomer
            ? "更新客户失败"
            : "创建客户失败",
      );
    } finally {
      setSavingCustomer(false);
    }
  };

  const openCustomerDelete = (customer: TradeCustomer) => {
    setCustomerDeleteTarget(customer);
    setCustomerDeleteReason("");
    setError("");
  };

  const submitCustomerDelete = async () => {
    if (!customerDeleteTarget) return;
    if (!tradeAccess?.is_admin && !customerDeleteReason.trim()) {
      setError("请填写删除客户的原因，管理员审批时会看到这段说明。");
      return;
    }
    setDeletingCustomer(true);
    setError("");
    try {
      const response = tradeAccess?.is_admin
        ? await api.delete<TradeCustomerDeleteRequest>(
            `/trade/customers/${customerDeleteTarget.id}`,
          )
        : await api.post<TradeCustomerDeleteRequest>(
            `/trade/customers/${customerDeleteTarget.id}/delete-request`,
            { reason: customerDeleteReason.trim() },
          );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "提交客户删除操作失败");
      setNotice(
        tradeAccess?.is_admin
          ? `客户「${customerDeleteTarget.name}」已删除，历史订单和客户频道仍然保留。`
          : `客户「${customerDeleteTarget.name}」的删除申请已提交，等待管理员审批。`,
      );
      if (tradeAccess?.is_admin) {
        setCustomerFilter("all");
      }
      setCustomerDeleteTarget(null);
      setCustomerDeleteReason("");
      await loadData(true);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "提交客户删除操作失败",
      );
    } finally {
      setDeletingCustomer(false);
    }
  };

  const rejectCustomerDelete = async (
    request: TradeCustomerDeleteRequest,
  ) => {
    if (!window.confirm(`确认拒绝删除客户「${request.customer_name}」吗？`))
      return;
    setDecidingCustomerDeleteID(request.id);
    setError("");
    try {
      const response = await api.put<TradeCustomerDeleteRequest>(
        `/trade/customer-delete-requests/${request.id}/decision`,
        { decision: "reject", comment: "管理员拒绝删除申请" },
      );
      if (response.code !== 0)
        throw new Error(response.message || "拒绝删除申请失败");
      setNotice(`已拒绝客户「${request.customer_name}」的删除申请。`);
      if (customerDeleteRequests.length <= 1)
        setCustomerDeleteApprovalsOpen(false);
      await loadData(true);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "拒绝删除申请失败",
      );
    } finally {
      setDecidingCustomerDeleteID(null);
    }
  };

  const approveCustomerDelete = (request: TradeCustomerDeleteRequest) => {
    const customer = customers.find((item) => item.id === request.customer_id);
    if (!customer) {
      setError("客户资料已经不存在，请刷新页面后重试。");
      return;
    }
    setCustomerDeleteApprovalsOpen(false);
    openCustomerDelete(customer);
  };

  const openOrderModal = (customerID = 0) => {
    if (customers.length === 0) {
      openCustomerModal("manual");
      setNotice("请先建立客户档案，再创建询价业务单。");
      return;
    }
    const selectedID = customerID || orderDraft.customer_id || customers[0].id;
    setOrderDraft(newOrderDraft(selectedID, settings.payment_methods[0]));
    setOrderItems([newOrderItem()]);
    setOrderModalOpen(true);
    setError("");
  };

  const updateOrderItem = (
    index: number,
    key: keyof OrderItemDraft,
    value: string,
  ) => {
    setOrderItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item,
      ),
    );
  };

  const openAddItems = () => {
    if (!detailOrder?.access?.can_add_items) {
      setError("当前流程阶段或岗位没有新增产品的权限。");
      return;
    }
    setAdditionalItems([newOrderItem()]);
    setItemModalOpen(true);
    setError("");
  };

  const updateAdditionalItem = (
    index: number,
    key: keyof OrderItemDraft,
    value: string,
  ) => {
    setAdditionalItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item,
      ),
    );
  };

  const saveAdditionalItems = async () => {
    if (!detailOrder) return;
    const validItems = additionalItems.filter(
      (item) => item.product_name.trim() && Number(item.quantity) > 0,
    );
    if (validItems.length === 0) {
      setError("请至少填写一行有效的产品名称和数量。");
      return;
    }
    setSavingItems(true);
    setError("");
    try {
      const existingIDs = new Set(
        (detailOrder.items || []).map((item) => item.id),
      );
      const response = await api.post<TradeOrder>(
        `/trade/orders/${detailOrder.id}/items`,
        {
          items: validItems.map((item) => ({
            ...item,
            quantity: Number(item.quantity),
            target_price: Number(item.target_price || 0),
          })),
        },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "新增产品失败");
      const firstAddedItem = (response.data.items || []).find(
        (item) => !existingIDs.has(item.id),
      );
      setDetailOrder(response.data);
      setItemModalOpen(false);
      setAdditionalItems([newOrderItem()]);
      if (quoteModalOpen && firstAddedItem) {
        setQuoteDraft((current) => ({
          ...current,
          order_item_id: firstAddedItem.id,
        }));
      }
      setNotice(
        `已新增 ${validItems.length} 个产品，并同步到报价、采购、到货、质检和装箱工作表。`,
      );
      await loadData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "新增产品失败");
    } finally {
      setSavingItems(false);
    }
  };

  const openStageDataModal = () => {
    if (!detailOrder?.can_operate_stage) {
      setError("当前账号不是本环节负责人，不能修改环节数据。");
      return;
    }
    const fields = STAGE_DATA_FIELDS[detailOrder.stage] || [];
    if (detailOrder.stage !== "shipment" && fields.length === 0) {
      setError("当前环节请使用对应的报价功能维护数据。");
      return;
    }
    setStageItemDrafts(
      Object.fromEntries(
        (detailOrder.items || []).map((item) => [
          item.id,
          Object.fromEntries(
            fields.map((field) => {
              let value = stageItemValue(item, field);
              if (!value && field.key === "sample_qty")
                value = String(item.received_quantity || item.quantity || 0);
              if (!value && field.key === "packed_quantity")
                value = String(item.packed_quantity || item.quantity || 0);
              if (
                !value &&
                [
                  "purchase_status",
                  "receipt_status",
                  "inspection_result",
                ].includes(field.key)
              ) {
                value = stageItemStatus(detailOrder.stage, item);
              }
              if (
                field.type === "select" &&
                field.options?.length &&
                !field.options.includes(value)
              ) {
                value = field.options[0];
              }
              return [field.key, value];
            }),
          ),
        ]),
      ),
    );
    setStageShipmentDraft(emptyStageShipmentDraft(detailOrder));
    setStageDataModalOpen(true);
    setError("");
  };

  const updateStageItemDraft = (itemID: number, key: string, value: string) => {
    setStageItemDrafts((current) => ({
      ...current,
      [itemID]: { ...(current[itemID] || {}), [key]: value },
    }));
  };

  const saveStageData = async () => {
    if (!detailOrder) return;
    const fields = STAGE_DATA_FIELDS[detailOrder.stage] || [];
    const numericFields = new Set([
      "quantity",
      "target_price",
      "purchase_price",
      "cost_exchange_rate",
      "received_quantity",
      "accepted_quantity",
      "packed_quantity",
      "carton_count",
      "gross_weight",
      "net_weight",
      "sample_qty",
    ]);
    const items = (detailOrder.items || []).map((item) => {
      const draft = stageItemDrafts[item.id] || {};
      const payload: Record<string, unknown> = {
        order_item_id: item.id,
        workflow_data: {},
      };
      const workflowData = payload.workflow_data as Record<string, unknown>;
      fields.forEach((field) => {
        const rawValue = draft[field.key] || "";
        const value = numericFields.has(field.key)
          ? Number(rawValue || 0)
          : rawValue.trim();
        if (field.source === "workflow") workflowData[field.key] = value;
        else payload[field.key] = value;
      });
      return payload;
    });
    setSavingStageData(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(
        `/trade/orders/${detailOrder.id}/stage-data`,
        detailOrder.stage === "shipment"
          ? {
              shipment: {
                ...stageShipmentDraft,
                actual_freight_amount: Number(
                  stageShipmentDraft.actual_freight_amount || 0,
                ),
                actual_freight_to_cny_rate:
                  stageShipmentDraft.actual_freight_currency.toUpperCase() ===
                  "CNY"
                    ? 1
                    : Number(
                        stageShipmentDraft.actual_freight_to_cny_rate || 0,
                      ),
              },
            }
          : { items },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "保存环节数据失败");
      setDetailOrder(response.data);
      setStageDataModalOpen(false);
      setNotice("环节数据已保存，并同步到 ERP 与流程工作簿。");
      await loadData(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存环节数据失败",
      );
    } finally {
      setSavingStageData(false);
    }
  };

  const deleteOrderItem = async () => {
    if (!detailOrder || !orderItemDeleteTarget) return;
    setDeletingOrderItem(true);
    setError("");
    try {
      const response = await api.delete<TradeOrder>(
        `/trade/orders/${detailOrder.id}/items/${orderItemDeleteTarget.id}`,
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "删除订单产品失败");
      setDetailOrder(response.data);
      setStageItemDrafts((current) => {
        const next = { ...current };
        delete next[orderItemDeleteTarget.id];
        return next;
      });
      setOrderItemDeleteTarget(null);
      setNotice("产品已从订单中删除，行号、订单金额和流程工作簿已同步更新。");
      await loadData(true);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "删除订单产品失败",
      );
    } finally {
      setDeletingOrderItem(false);
    }
  };

  const saveOrder = async () => {
    const validItems = orderItems.filter(
      (item) => item.product_name.trim() && Number(item.quantity) > 0,
    );
    if (
      !orderDraft.customer_id ||
      !orderDraft.title.trim() ||
      validItems.length === 0
    )
      return setError("请选择客户、填写询价主题，并至少录入一行产品。");
    setSavingOrder(true);
    setError("");
    try {
      const response = await api.post<TradeOrder>("/trade/orders", {
        ...orderDraft,
        title: orderDraft.title.trim(),
        payment_terms: orderDraft.payment_method,
        items: validItems.map((item) => ({
          ...item,
          quantity: Number(item.quantity),
          target_price: Number(item.target_price || 0),
        })),
      });
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "创建询价业务单失败");
      setOrderModalOpen(false);
      setDetailOrder(response.data);
      detailOrderIDRef.current = response.data.id;
      setNotice(
        `业务单 ${response.data.order_no} 已创建，九张流程工作表已就绪。`,
      );
      await loadData(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "创建询价业务单失败",
      );
    } finally {
      setSavingOrder(false);
    }
  };

  const saveSupplier = async () => {
    if (!supplierDraft.name.trim()) return setError("请输入供应商名称。");
    setSavingSupplier(true);
    setError("");
    try {
      const response = await api.post<TradeSupplier>(
        "/trade/suppliers",
        supplierDraft,
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "创建供应商失败");
      setSupplierModalOpen(false);
      setNotice(`供应商「${response.data.name}」已录入。`);
      await loadData(true);
      if (quoteModalOpen)
        setQuoteDraft((current) => ({
          ...current,
          supplier_id: response.data!.id,
        }));
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "创建供应商失败",
      );
    } finally {
      setSavingSupplier(false);
    }
  };

  const openOrderDetail = async (order: TradeOrder) => {
    setDetailOrder(order);
    detailOrderIDRef.current = order.id;
    setAdvanceNote("");
    setInspectionFiles([]);
    setInspectionNote("");
    setTimelineExpanded(false);
    await loadOrderDetail(order.id);
  };

  const openOrderByID = async (orderID: number) => {
    const order = orders.find((candidate) => candidate.id === orderID);
    if (order) {
      await openOrderDetail(order);
      return;
    }
    await loadOrderDetail(orderID);
  };

  const closeOrderDetail = () => {
    setDetailOrder(null);
    detailOrderIDRef.current = null;
    setTimelineExpanded(false);
    persistWorkspaceState();
  };

  const viewCustomerOrders = (customer: TradeCustomer) => {
    setCustomerFilter(customer.id);
    setOwnerFilter("all");
    setShowOnlyMine(false);
    setStageFilter("all");
    setSearch("");
    setActiveView("orders");
    setNotice(`正在查看客户「${customer.name}」的往来订单。`);
  };

  const openPIModal = () => {
    if (!detailOrder?.access?.can_view_customer_pricing) {
      setError("当前账号没有生成客户 PI 的权限。");
      return;
    }
    const quotes = (detailOrder.customer_quotes || []).filter(
      (quote) => quote.status !== "draft" && quote.status !== "rejected",
    );
    const selected =
      quotes.find((quote) => quote.status === "accepted") || quotes[0];
    if (!selected) {
      setError("请先创建并发送一轮对客报价，再生成 PI。");
      return;
    }
    const today = new Date();
    const validUntil = new Date(today);
    validUntil.setDate(validUntil.getDate() + 14);
    const destination = [
      detailOrder.incoterm,
      detailOrder.destination_country,
      detailOrder.destination_port,
    ]
      .filter(Boolean)
      .join(" ");
    setPIDraft({
      quote_id: selected.id,
      issue_date: formatTradeInputDate(today),
      valid_until: formatTradeInputDate(validUntil),
      payment_method:
        detailOrder.payment_method ||
        detailOrder.payment_terms ||
        settings.payment_methods[0] ||
        "",
      delivery_terms: destination,
      delivery_time: "",
      notes: "",
    });
    setPIPreviewURL("");
    setPIModalOpen(true);
    setError("");
  };

  const closePIModal = () => {
    setPIModalOpen(false);
    setPIDraft(null);
    setPIPreviewURL("");
  };

  const updatePIDraft = (patch: Partial<TradePIDraft>) => {
    setPIDraft((current) => (current ? { ...current, ...patch } : current));
    setPIPreviewURL("");
  };

  const loadPIBlob = async (download: boolean) => {
    if (!detailOrder || !piDraft) throw new Error("PI 参数不完整。");
    const response = await api.download(
      `/trade/orders/${detailOrder.id}/pi/pdf${download ? "?download=1" : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(piDraft),
      },
    );
    if (!response.ok) {
      let message = "生成 PI PDF 失败。";
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // Binary endpoints may not return JSON for transport errors.
      }
      throw new Error(message);
    }
    return { response, blob: await response.blob() };
  };

  const previewPI = async () => {
    setPIAction("preview");
    setError("");
    try {
      const { blob } = await loadPIBlob(false);
      setPIPreviewURL(window.URL.createObjectURL(blob));
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "预览 PI PDF 失败。",
      );
    } finally {
      setPIAction(null);
    }
  };

  const downloadPI = async () => {
    if (!detailOrder) return;
    setPIAction("download");
    setError("");
    try {
      const { response, blob } = await loadPIBlob(true);
      triggerTradeDownload(
        blob,
        tradeDownloadFilename(
          response.headers.get("Content-Disposition"),
          `PI-${detailOrder.order_no}.pdf`,
        ),
      );
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "下载 PI PDF 失败。",
      );
    } finally {
      setPIAction(null);
    }
  };

  const sendPI = async () => {
    if (!detailOrder || !piDraft) return;
    setPIAction("send");
    setError("");
    try {
      const response = await api.post(
        `/trade/orders/${detailOrder.id}/pi/send`,
        piDraft,
      );
      if (response.code !== 0)
        throw new Error(response.message || "发送 PI 失败。");
      closePIModal();
      setNotice(
        `PI 已发送到客户「${detailOrder.customer_name}」的频道；如频道已联动 WhatsApp，将继续发送给客户。`,
      );
    } catch (sendError) {
      setError(
        sendError instanceof Error ? sendError.message : "发送 PI 失败。",
      );
    } finally {
      setPIAction(null);
    }
  };

  const openProfitSettings = () => {
    if (!detailOrder?.access?.can_view_profit) return;
    const itemRates = Object.fromEntries(
      (detailOrder.profit_summary?.lines || []).map((line) => [
        line.order_item_id,
        line.cost_exchange_rate > 0 ? String(line.cost_exchange_rate) : "",
      ]),
    );
    setProfitSettingsDraft({
      additional_cost_amount: String(detailOrder.additional_cost_amount || 0),
      additional_cost_notes: detailOrder.additional_cost_notes || "",
      item_rates: itemRates,
    });
    setProfitSettingsOpen(true);
    setError("");
  };

  const saveProfitSettings = async () => {
    if (!detailOrder || !profitSettingsDraft) return;
    setSavingProfitSettings(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(
        `/trade/orders/${detailOrder.id}/profit-settings`,
        {
          additional_cost_amount: Number(
            profitSettingsDraft.additional_cost_amount || 0,
          ),
          additional_cost_notes:
            profitSettingsDraft.additional_cost_notes.trim(),
          item_rates: (detailOrder.items || []).map((item) => ({
            order_item_id: item.id,
            rate: Number(profitSettingsDraft.item_rates[item.id] || 0),
          })),
        },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "保存利润设置失败");
      setDetailOrder(response.data);
      setProfitSettingsOpen(false);
      setProfitSettingsDraft(null);
      setNotice("成本、汇率和利润汇总已更新，并同步到流程工作簿。");
      await loadData(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存利润设置失败",
      );
    } finally {
      setSavingProfitSettings(false);
    }
  };

  const deleteOrder = async () => {
    if (!deleteTarget) return;
    setDeletingOrder(true);
    setError("");
    try {
      const response = await api.delete(`/trade/orders/${deleteTarget.id}`);
      if (response.code !== 0)
        throw new Error(response.message || "删除业务订单失败");
      if (detailOrderIDRef.current === deleteTarget.id) closeOrderDetail();
      setDeleteTarget(null);
      setNotice(
        `业务订单 ${deleteTarget.order_no} 已移入回收站，30 天内可完整还原。`,
      );
      await loadData(true);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "删除业务订单失败",
      );
    } finally {
      setDeletingOrder(false);
    }
  };

  const flowOrder = async (targetStage: TradeStage) => {
    if (!detailOrder) return;
    setFlowing(true);
    setError("");
    try {
      const response = await api.post<TradeOrder>(
        `/trade/orders/${detailOrder.id}/advance`,
        { to_stage: targetStage, note: advanceNote.trim() },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "流转业务流程失败");
      const handedOff = response.data.access?.scope_label === "任务已交接";
      setDetailOrder(handedOff ? null : response.data);
      detailOrderIDRef.current = handedOff ? null : response.data.id;
      setAdvanceNote("");
      setNotice(
        `${response.data.order_no} 已进入${stageDefinition(targetStage)?.label || targetStage}阶段${handedOff ? "，任务已交接给下一岗位。" : "。"}`,
      );
      await loadData(true);
    } catch (flowError) {
      setError(
        flowError instanceof Error ? flowError.message : "流转业务流程失败",
      );
    } finally {
      setFlowing(false);
    }
  };

  const saveSupplierQuote = async () => {
    if (!detailOrder || !quoteDraft.order_item_id || !quoteDraft.supplier_id)
      return setError("请选择产品和供应商。");
    setSavingQuote(true);
    setError("");
    try {
      const response = await api.post<TradeOrder>(
        `/trade/orders/${detailOrder.id}/supplier-quotes`,
        {
          ...quoteDraft,
          unit_price: Number(quoteDraft.unit_price || 0),
          moq: Number(quoteDraft.moq || 0),
          lead_time_days: Number(quoteDraft.lead_time_days || 0),
        },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "保存供应商报价失败");
      setDetailOrder(response.data);
      setQuoteModalOpen(false);
      setNotice("供应商报价已保存并同步到流程工作簿。");
      await loadData(true);
    } catch (quoteError) {
      setError(
        quoteError instanceof Error ? quoteError.message : "保存供应商报价失败",
      );
    } finally {
      setSavingQuote(false);
    }
  };

  const selectSupplierQuote = async (quoteID: number) => {
    if (!detailOrder) return;
    setError("");
    try {
      const response = await api.post<TradeOrder>(
        `/trade/orders/${detailOrder.id}/supplier-quotes/${quoteID}/select`,
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "采用供应商报价失败");
      setDetailOrder(response.data);
      setNotice("已采用该供应商报价，采购资料已同步。");
      await loadData(true);
    } catch (selectError) {
      setError(
        selectError instanceof Error
          ? selectError.message
          : "采用供应商报价失败",
      );
    }
  };

  const openCustomerQuoteModal = (source?: TradeCustomerQuoteRound) => {
    if (!detailOrder) return;
    setCustomerQuoteDraft(newCustomerQuoteDraft(detailOrder, source));
    setCustomerQuoteModalOpen(true);
    setError("");
  };

  const updateCustomerQuoteItemPrice = (
    orderItemID: number,
    unitPrice: string,
  ) => {
    setCustomerQuoteDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.order_item_id === orderItemID
                ? { ...item, unit_price: unitPrice }
                : item,
            ),
          }
        : current,
    );
  };

  const saveCustomerQuoteRound = async () => {
    if (!detailOrder || !customerQuoteDraft) return;
    if (
      customerQuoteDraft.items.some(
        (item) => !item.unit_price || Number(item.unit_price) <= 0,
      )
    ) {
      setError("请为本轮所有产品填写大于零的对客单价。");
      return;
    }
    const exchangeRateCNY = Number(customerQuoteDraft.exchange_rate_cny || 0);
    if (
      customerQuoteDraft.currency.toUpperCase() !== "CNY" &&
      exchangeRateCNY <= 0
    ) {
      setError(`请填写 1 ${customerQuoteDraft.currency} 兑人民币的报价汇率。`);
      return;
    }
    if (
      customerQuoteDraft.freight_mode === "quoted" &&
      Number(customerQuoteDraft.freight_amount || 0) <= 0
    ) {
      setError("选择我方报价运费后，请填写大于零的运费金额。");
      return;
    }
    setSavingCustomerQuote(true);
    setError("");
    try {
      const response = await api.post<TradeOrder>(
        `/trade/orders/${detailOrder.id}/customer-quotes`,
        {
          currency: customerQuoteDraft.currency,
          exchange_rate_cny:
            customerQuoteDraft.currency.toUpperCase() === "CNY"
              ? 1
              : exchangeRateCNY,
          freight_mode: customerQuoteDraft.freight_mode,
          freight_amount:
            customerQuoteDraft.freight_mode === "quoted"
              ? Number(customerQuoteDraft.freight_amount || 0)
              : 0,
          status: customerQuoteDraft.status,
          customer_feedback: customerQuoteDraft.customer_feedback.trim(),
          notes: customerQuoteDraft.notes.trim(),
          items: customerQuoteDraft.items.map((item) => ({
            order_item_id: item.order_item_id,
            unit_price: Number(item.unit_price),
          })),
        },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "保存对客报价失败");
      setDetailOrder(response.data);
      setCustomerQuoteModalOpen(false);
      setCustomerQuoteDraft(null);
      setNotice(
        customerQuoteDraft.status === "sent"
          ? "新一轮报价已记录为向客户发送，等待客户反馈。"
          : "对客报价草稿已保存。",
      );
      await loadData(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存对客报价失败",
      );
    } finally {
      setSavingCustomerQuote(false);
    }
  };

  const openCustomerQuoteStatus = (
    quote: TradeCustomerQuoteRound,
    status: CustomerQuoteStatusDraft["status"],
  ) => {
    setCustomerQuoteStatusDraft({
      quote,
      status,
      customer_feedback: quote.customer_feedback || "",
      notes: quote.notes || "",
    });
    setError("");
  };

  const saveCustomerQuoteStatus = async () => {
    if (!detailOrder || !customerQuoteStatusDraft) return;
    if (
      customerQuoteStatusDraft.status === "negotiating" &&
      !customerQuoteStatusDraft.customer_feedback.trim()
    ) {
      setError("请记录客户砍价、目标价或其他议价反馈。");
      return;
    }
    setSavingCustomerQuoteStatus(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(
        `/trade/orders/${detailOrder.id}/customer-quotes/${customerQuoteStatusDraft.quote.id}/status`,
        {
          status: customerQuoteStatusDraft.status,
          customer_feedback: customerQuoteStatusDraft.customer_feedback.trim(),
          notes: customerQuoteStatusDraft.notes.trim(),
        },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "更新报价状态失败");
      setDetailOrder(response.data);
      setCustomerQuoteStatusDraft(null);
      setNotice(
        `第 ${customerQuoteStatusDraft.quote.round_no} 轮报价已更新为“${customerQuoteStatusLabels[customerQuoteStatusDraft.status]}”。`,
      );
      await loadData(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "更新报价状态失败",
      );
    } finally {
      setSavingCustomerQuoteStatus(false);
    }
  };

  const syncWorkbook = async () => {
    if (!detailOrder) return;
    setSyncingWorkbook(true);
    setError("");
    try {
      const response = await api.post<TradeOrder>(
        `/trade/orders/${detailOrder.id}/sync-workbook`,
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "同步流程工作簿失败");
      setDetailOrder(response.data);
      setNotice("流程工作簿已按当前 ERP 数据补齐并校准。");
    } catch (syncError) {
      setError(
        syncError instanceof Error ? syncError.message : "同步流程工作簿失败",
      );
    } finally {
      setSyncingWorkbook(false);
    }
  };

  const uploadInspectionPhotos = async () => {
    if (!detailOrder || inspectionFiles.length === 0)
      return setError("请选择至少一张质检图片。");
    setUploadingInspection(true);
    setError("");
    try {
      for (const file of inspectionFiles) {
        const body = new FormData();
        body.append("file", file);
        if (inspectionItemID)
          body.append("order_item_id", String(inspectionItemID));
        body.append("note", inspectionNote.trim());
        const response = await api.form<TradeInspectionPhoto>(
          `/trade/orders/${detailOrder.id}/inspection-photos`,
          body,
        );
        if (response.code !== 0)
          throw new Error(response.message || `上传 ${file.name} 失败`);
      }
      setInspectionFiles([]);
      setInspectionNote("");
      await loadOrderDetail(detailOrder.id, false);
      setNotice(
        `已上传 ${inspectionFiles.length} 张质检图片，并保存到订单质检图库目录。`,
      );
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "上传质检图片失败",
      );
    } finally {
      setUploadingInspection(false);
    }
  };

  const savePositionAssignments = async () => {
    setSavingSettings(true);
    setError("");
    try {
      const response = await api.put<TradePosition[]>(
        "/trade/positions/assignments",
        { assignments: positionsDraft },
      );
      if (response.code !== 0)
        throw new Error(response.message || "保存职位配置失败");
      setPositions(response.data || []);
      setNotice("职位配置已保存。一个员工可以同时属于多个职位。");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存职位配置失败",
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const saveTradeSettings = async () => {
    setSavingSettings(true);
    setError("");
    try {
      const paymentMethods = paymentMethodsText
        .split(/\n|,|，/)
        .map((value) => value.trim())
        .filter(Boolean);
      const response = await api.put<TradeSettings>("/trade/settings", {
        payment_methods: paymentMethods,
        pi_profile: piProfileDraft,
      });
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "保存外贸设置失败");
      setSettings(response.data);
      setPaymentMethodsText(response.data.payment_methods.join("\n"));
      setPIProfileDraft(response.data.pi_profile);
      setNotice(
        settingsTab === "pi"
          ? "PI 公司抬头与收款资料已保存。"
          : "常用付款方式已保存。",
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存外贸设置失败",
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const rememberAndNavigate = (target: string) => {
    persistWorkspaceState();
    setReturnTarget("/trade");
    router.push(target);
  };

  const openChannel = (channelID?: number) => {
    if (!channelID) return;
    if (profile?.id)
      localStorage.setItem(
        `yaerp:channels:${profile.id}:active-channel`,
        String(channelID),
      );
    rememberAndNavigate("/channels");
  };

  const metrics = [
    {
      label: "客户",
      value: dashboard?.customer_count || 0,
      icon: Users,
      color: "text-slate-700",
    },
    {
      label: "进行中",
      value: dashboard?.active_order_count || 0,
      icon: BriefcaseBusiness,
      color: "text-sky-700",
    },
    {
      label: "待询价/报价",
      value: dashboard?.pending_quote_count || 0,
      icon: Clock3,
      color: "text-amber-700",
    },
    {
      label: "采购中",
      value: dashboard?.purchase_count || 0,
      icon: ShoppingCart,
      color: "text-violet-700",
    },
    {
      label: "仓库环节",
      value: dashboard?.warehouse_count || 0,
      icon: Warehouse,
      color: "text-cyan-700",
    },
    {
      label: "运输中",
      value: dashboard?.shipping_count || 0,
      icon: Ship,
      color: "text-blue-700",
    },
    {
      label: "报价逾期",
      value: dashboard?.overdue_quote_count || 0,
      icon: CalendarDays,
      color: "text-rose-700",
    },
    {
      label: "本月完成",
      value: dashboard?.completed_this_month || 0,
      icon: PackageCheck,
      color: "text-emerald-700",
    },
  ];

  const paymentOptions = settings.payment_methods.length
    ? settings.payment_methods
    : ["T/T 电汇"];

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100 text-slate-900">
        <CurrencySearchEnhancer />
        <datalist id="trade-payment-options">
          {paymentOptions.map((method) => (
            <option key={method} value={method} />
          ))}
        </datalist>

        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex min-h-16 max-w-[1600px] items-center justify-between gap-3 px-3 py-2 md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                title="返回工作台"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                <BriefcaseBusiness className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold">外贸业务中心</h1>
                <p className="truncate text-xs text-slate-500">
                  {tradeAccess?.scope_label ||
                    "客户询价 · 供应商比价 · 报价 · 采购 · 仓库 · 质检 · 装箱 · 发货"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadData(true)}
                disabled={refreshing}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                title="刷新业务数据"
              >
                <RefreshCw
                  className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                />
              </button>
              {adminMode && (
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                  title="职位与外贸设置"
                >
                  <Settings className="h-4 w-4" />
                </button>
              )}
              {tradeAccess?.can_create_customers && (
                <button
                  type="button"
                  onClick={() => openCustomerModal("manual")}
                  className="hidden h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:inline-flex"
                >
                  <UserPlus className="h-4 w-4" />
                  录入客户
                </button>
              )}
              {tradeAccess?.can_create_orders && (
                <button
                  type="button"
                  onClick={() => openOrderModal()}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  <Plus className="h-4 w-4" />
                  新建询价
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1600px] p-3 md:p-5">
          {(error || notice) && (
            <div
              className={`mb-3 flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
            >
              <span>{error || notice}</span>
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
                className="shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <section className="grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-white md:grid-cols-4 xl:grid-cols-8">
            {metrics.map((metric, index) => {
              const Icon = metric.icon;
              return (
                <div
                  key={metric.label}
                  className={`flex min-h-20 items-center gap-3 px-4 py-3 ${index % 2 === 0 ? "border-r border-slate-100" : ""} md:border-r md:last:border-r-0`}
                >
                  <Icon className={`h-5 w-5 shrink-0 ${metric.color}`} />
                  <div>
                    <div className="text-xl font-semibold tabular-nums">
                      {metric.value}
                    </div>
                    <div className="text-xs text-slate-500">{metric.label}</div>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setActiveView("orders")}
                  className={`h-8 shrink-0 rounded-md px-3 text-sm font-medium ${activeView === "orders" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                >
                  业务单
                </button>
                {tradeAccess?.can_view_customers && (
                  <button
                    type="button"
                    onClick={() => setActiveView("customers")}
                    className={`h-8 shrink-0 rounded-md px-3 text-sm font-medium ${activeView === "customers" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                  >
                    客户
                  </button>
                )}
                {tradeAccess?.can_view_suppliers && (
                  <button
                    type="button"
                    onClick={() => setActiveView("suppliers")}
                    className={`h-8 shrink-0 rounded-md px-3 text-sm font-medium ${activeView === "suppliers" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                  >
                    供应商
                  </button>
                )}
                {tradeAccess?.can_view_all_orders && (
                  <button
                    type="button"
                    onClick={() => setActiveView("boss")}
                    className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium ${activeView === "boss" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                  >
                    <BarChart3 className="h-3.5 w-3.5" />
                    老板面板
                  </button>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
                {activeView !== "boss" && (
                  <label className="flex h-9 min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-500 lg:max-w-sm">
                    <Search className="h-4 w-4 shrink-0" />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={
                        activeView === "orders"
                          ? "搜索业务单、客户、目的港..."
                          : activeView === "customers"
                            ? "搜索客户、公司、电话..."
                            : "搜索供应商、联系人、电话..."
                      }
                      className="min-w-0 flex-1 outline-none"
                    />
                  </label>
                )}
                {activeView === "orders" &&
                  tradeAccess?.can_view_all_orders && (
                    <select
                      value={ownerFilter}
                      onChange={(event) => {
                        setOwnerFilter(
                          event.target.value === "all"
                            ? "all"
                            : Number(event.target.value),
                        );
                        setShowOnlyMine(false);
                      }}
                      className="h-9 max-w-44 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 outline-none"
                      title="按业务员查看"
                    >
                      <option value="all">全部业务员</option>
                      {orderOwners.map((owner) => (
                        <option key={owner.id} value={owner.id}>
                          {owner.name || `用户 #${owner.id}`}
                        </option>
                      ))}
                    </select>
                  )}
                {activeView === "orders" && (
                  <select
                    value={customerFilter}
                    onChange={(event) =>
                      setCustomerFilter(
                        event.target.value === "all"
                          ? "all"
                          : Number(event.target.value),
                      )
                    }
                    className="h-9 max-w-48 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 outline-none"
                    title="按客户查看往来订单"
                  >
                    <option value="all">全部客户</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                )}
                {activeView !== "boss" && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowOnlyMine((current) => !current);
                      setOwnerFilter("all");
                    }}
                    className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${showOnlyMine ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                    title="只显示由我负责的数据"
                  >
                    <Check
                      className={`h-4 w-4 ${showOnlyMine ? "" : "opacity-30"}`}
                    />
                    <span className="hidden sm:inline">仅看我的</span>
                  </button>
                )}
                {activeView === "customers" &&
                  tradeAccess?.is_admin && (
                    <button
                      type="button"
                      onClick={() => setCustomerDeleteApprovalsOpen(true)}
                      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${customerDeleteRequests.length > 0 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 text-slate-500"}`}
                      title="审批员工提交的客户删除申请"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      <span>删除审批</span>
                      <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                        {customerDeleteRequests.length}
                      </span>
                    </button>
                  )}
                {activeView === "customers" &&
                  tradeAccess?.can_create_customers && (
                    <button
                      type="button"
                      onClick={() => openCustomerModal("whatsapp")}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-emerald-200 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                    >
                      <MessageCircle className="h-4 w-4" />
                      <span className="hidden sm:inline">从 WhatsApp 录入</span>
                    </button>
                  )}
                {activeView === "suppliers" &&
                  tradeAccess?.can_manage_suppliers && (
                    <button
                      type="button"
                      onClick={() => {
                        setSupplierDraft(newSupplierDraft(paymentOptions[0]));
                        setSupplierModalOpen(true);
                      }}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white"
                    >
                      <Plus className="h-4 w-4" />
                      供应商
                    </button>
                  )}
              </div>
            </div>

            {activeView === "orders" && (
              <>
                <div className="overflow-x-auto border-b border-slate-200 p-3">
                  <div className="flex min-w-max items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setStageFilter("all")}
                      className={`h-9 rounded-lg border px-3 text-sm font-medium ${stageFilter === "all" ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                    >
                      全部 {orders.length}
                    </button>
                    {STAGES.map((stage) => {
                      const Icon = stage.icon;
                      const count = dashboard?.stage_counts?.[stage.key] || 0;
                      return (
                        <button
                          key={stage.key}
                          type="button"
                          onClick={() => setStageFilter(stage.key)}
                          className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${stageFilter === stage.key ? `${stage.background} ${stage.color} border-current` : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                        >
                          <Icon className="h-4 w-4" />
                          {stage.shortLabel}
                          <span className="text-xs opacity-60">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1120px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-4 py-3">业务单</th>
                        <th className="px-4 py-3">客户</th>
                        <th className="px-4 py-3">当前环节</th>
                        <th className="px-4 py-3">负责职位</th>
                        <th className="px-4 py-3">产品</th>
                        <th className="px-4 py-3">目的地</th>
                        <th className="px-4 py-3">报价截止</th>
                        <th className="px-4 py-3">业务员</th>
                        <th className="px-4 py-3 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading ? (
                        <tr>
                          <td
                            colSpan={9}
                            className="h-56 text-center text-slate-400"
                          >
                            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                            加载业务单...
                          </td>
                        </tr>
                      ) : filteredOrders.length === 0 ? (
                        <tr>
                          <td
                            colSpan={9}
                            className="h-48 text-center text-slate-400"
                          >
                            没有匹配的业务单
                          </td>
                        </tr>
                      ) : (
                        filteredOrders.map((order) => {
                          const stage = stageDefinition(order.stage);
                          const StageIcon = stage?.icon || BriefcaseBusiness;
                          return (
                            <tr
                              key={order.id}
                              className="border-t border-slate-100 hover:bg-slate-50/70"
                            >
                              <td className="px-4 py-3">
                                <button
                                  type="button"
                                  onClick={() => void openOrderDetail(order)}
                                  className="text-left"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-slate-900">
                                      {order.order_no}
                                    </span>
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${priorityClass(order.priority)}`}
                                    >
                                      {PRIORITY_LABELS[order.priority]}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 max-w-64 truncate text-xs text-slate-500">
                                    {order.title}
                                  </div>
                                </button>
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-medium">
                                  {order.customer_name}
                                </div>
                                <div className="mt-0.5 max-w-48 truncate text-xs text-slate-400">
                                  {order.customer_company}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${stage?.background || "bg-slate-100"} ${stage?.color || "text-slate-600"}`}
                                >
                                  <StageIcon className="h-3.5 w-3.5" />
                                  {stage?.label || order.stage}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-xs font-medium">
                                  {order.required_position_name || "业务负责人"}
                                </div>
                                {order.can_operate_stage && (
                                  <div className="mt-0.5 text-[11px] text-emerald-600">
                                    可处理
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 tabular-nums">
                                {order.item_count} 项
                              </td>
                              <td className="px-4 py-3">
                                <div>
                                  {order.destination_country || "未设置"}
                                </div>
                                <div className="mt-0.5 text-xs text-slate-400">
                                  {order.destination_port}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                {formatDate(order.quote_deadline)}
                              </td>
                              <td className="px-4 py-3">{order.owner_name}</td>
                              <td className="px-4 py-3">
                                <div className="flex justify-end gap-1">
                                  {order.workbook_id &&
                                    order.workbook_sheet_id && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          rememberAndNavigate(
                                            `/sheets/${order.workbook_id}/${order.workbook_sheet_id}`,
                                          )
                                        }
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-emerald-700 hover:bg-emerald-50"
                                        title="打开流程工作簿"
                                      >
                                        <FileSpreadsheet className="h-4 w-4" />
                                      </button>
                                    )}
                                  {order.channel_id && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        openChannel(order.channel_id)
                                      }
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-sky-700 hover:bg-sky-50"
                                      title="打开客户频道"
                                    >
                                      <MessageSquare className="h-4 w-4" />
                                    </button>
                                  )}
                                  {tradeAccess?.is_admin && (
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(order)}
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50"
                                      title="删除业务订单"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => void openOrderDetail(order)}
                                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                                  >
                                    详情
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {activeView === "boss" && (
              <div className="bg-slate-50/60 p-3 md:p-4">
                {!bossDashboard ? (
                  <div className="flex h-64 items-center justify-center text-sm text-slate-400">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    加载经营数据...
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6">
                      {[
                        ["全部订单", bossDashboard.total_orders],
                        ["进行中", bossDashboard.active_orders],
                        ["已完成", bossDashboard.completed_orders],
                        ["盈利订单", bossDashboard.profitable_orders],
                        ["亏损订单", bossDashboard.loss_orders],
                        ["成本待补", bossDashboard.incomplete_cost_orders],
                      ].map(([label, value], index) => (
                        <div
                          key={String(label)}
                          className={`px-4 py-3 ${index > 0 ? "border-t border-slate-100 sm:border-l sm:border-t-0" : ""}`}
                        >
                          <div className="text-xs text-slate-400">{label}</div>
                          <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>

                    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
                        <div>
                          <h3 className="text-sm font-semibold">
                            月度盈利 Dashboard
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-400">
                            最近 12 个月，仅汇总已完成且成本、汇率完整的订单。
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 bg-sky-500" />
                            收入
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 bg-slate-500" />
                            成本
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 bg-emerald-500" />
                            利润
                          </span>
                        </div>
                      </div>
                      <div className="overflow-x-auto px-4 py-4">
                        <div className="flex h-56 min-w-[860px] items-end gap-3 border-b border-slate-200 pb-7">
                          {(bossDashboard.monthly || []).map((month) => {
                            const revenueHeight =
                              (Math.abs(month.revenue_cny) / monthlyProfitMax) *
                              150;
                            const costHeight =
                              (Math.abs(month.total_cost_cny) /
                                monthlyProfitMax) *
                              150;
                            const profitHeight =
                              (Math.abs(month.profit_amount_cny) /
                                monthlyProfitMax) *
                              150;
                            return (
                              <div
                                key={month.month}
                                className="relative flex min-w-0 flex-1 flex-col items-center"
                                title={`${formatTradeMonth(month.month)}：完成 ${month.completed_orders} 单，已核算 ${month.finalized_orders} 单，待补 ${month.incomplete_orders} 单；收入 CNY ${month.revenue_cny.toFixed(2)}，成本 CNY ${month.total_cost_cny.toFixed(2)}，利润 CNY ${month.profit_amount_cny.toFixed(2)}`}
                              >
                                <div className="flex h-[158px] items-end gap-1">
                                  <div
                                    className="w-3 bg-sky-500"
                                    style={{
                                      height: `${revenueHeight > 0 ? Math.max(3, revenueHeight) : 0}px`,
                                    }}
                                  />
                                  <div
                                    className="w-3 bg-slate-500"
                                    style={{
                                      height: `${costHeight > 0 ? Math.max(3, costHeight) : 0}px`,
                                    }}
                                  />
                                  <div
                                    className={`w-3 ${month.profit_amount_cny < 0 ? "bg-rose-500" : "bg-emerald-500"}`}
                                    style={{
                                      height: `${profitHeight > 0 ? Math.max(3, profitHeight) : 0}px`,
                                    }}
                                  />
                                </div>
                                <div className="absolute top-[164px] whitespace-nowrap text-[10px] font-medium text-slate-500">
                                  {formatTradeMonth(month.month)}
                                </div>
                                <div className="absolute top-[181px] whitespace-nowrap text-[9px] text-slate-400">
                                  {month.completed_orders === 0
                                    ? "0 单"
                                    : month.finalized_orders ===
                                        month.completed_orders
                                      ? `${month.completed_orders} 单`
                                      : `${month.finalized_orders}/${month.completed_orders} 已核算`}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <details className="border-t border-slate-200">
                        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                          查看月度明细
                        </summary>
                        <div className="overflow-x-auto border-t border-slate-100">
                          <table className="w-full min-w-[900px] text-sm">
                            <thead className="bg-slate-50 text-left text-xs text-slate-500">
                              <tr>
                                <th className="px-4 py-2.5">月份</th>
                                <th className="px-4 py-2.5 text-right">
                                  完成 / 已核算
                                </th>
                                <th className="px-4 py-2.5 text-right">收入</th>
                                <th className="px-4 py-2.5 text-right">成本</th>
                                <th className="px-4 py-2.5 text-right">利润</th>
                                <th className="px-4 py-2.5 text-right">
                                  运费利润
                                </th>
                                <th className="px-4 py-2.5 text-right">
                                  利润率
                                </th>
                                <th className="px-4 py-2.5 text-right">
                                  待补数据
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {(bossDashboard.monthly || [])
                                .slice()
                                .reverse()
                                .map((month) => (
                                  <tr
                                    key={month.month}
                                    className="border-t border-slate-100"
                                  >
                                    <td className="px-4 py-2.5 font-semibold">
                                      {formatTradeMonth(month.month)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                      {month.completed_orders} /{" "}
                                      {month.finalized_orders}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                      {formatFinancialMoney(
                                        "CNY",
                                        month.revenue_cny,
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                      {formatFinancialMoney(
                                        "CNY",
                                        month.total_cost_cny,
                                      )}
                                    </td>
                                    <td
                                      className={`px-4 py-2.5 text-right font-semibold tabular-nums ${month.profit_amount_cny < 0 ? "text-rose-600" : "text-emerald-700"}`}
                                    >
                                      {formatFinancialMoney(
                                        "CNY",
                                        month.profit_amount_cny,
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                      {formatFinancialMoney(
                                        "CNY",
                                        month.freight_profit_cny,
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                      {formatPercent(month.profit_margin)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">
                                      {month.incomplete_orders}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </section>

                    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                      <div className="border-b border-slate-200 px-4 py-3">
                        <h3 className="text-sm font-semibold">
                          人民币经营汇总
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-400">
                          仅统计已配置报价汇率的订单，共{" "}
                          {bossDashboard.cny_complete_orders} 单。
                        </p>
                      </div>
                      <div className="grid gap-px bg-slate-200 sm:grid-cols-2 xl:grid-cols-5">
                        {[
                          ["折合销售额", bossDashboard.revenue_cny],
                          ["折合总成本", bossDashboard.total_cost_cny],
                          ["订单总利润", bossDashboard.profit_amount_cny],
                          ["向客户报价运费", bossDashboard.freight_revenue_cny],
                          ["运费利润", bossDashboard.freight_profit_cny],
                        ].map(([label, value]) => (
                          <div
                            key={String(label)}
                            className="bg-white px-4 py-3"
                          >
                            <div className="text-xs text-slate-400">
                              {label}
                            </div>
                            <div className="mt-1 text-base font-semibold tabular-nums text-slate-900">
                              {formatFinancialMoney("CNY", Number(value))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                      <div className="border-b border-slate-200 px-4 py-3">
                        <h3 className="text-sm font-semibold">
                          分币种经营汇总
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-400">
                          不同币种独立汇总，不进行未经配置的跨币种合并。
                        </p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[1180px] text-sm">
                          <thead className="bg-slate-50 text-left text-xs text-slate-500">
                            <tr>
                              <th className="px-4 py-2.5">币种</th>
                              <th className="px-4 py-2.5 text-right">订单数</th>
                              <th className="px-4 py-2.5 text-right">
                                商品收入
                              </th>
                              <th className="px-4 py-2.5 text-right">
                                报价运费
                              </th>
                              <th className="px-4 py-2.5 text-right">
                                产品成本
                              </th>
                              <th className="px-4 py-2.5 text-right">
                                附加成本
                              </th>
                              <th className="px-4 py-2.5 text-right">
                                实际运费
                              </th>
                              <th className="px-4 py-2.5 text-right">
                                运费利润
                              </th>
                              <th className="px-4 py-2.5 text-right">利润</th>
                              <th className="px-4 py-2.5 text-right">利润率</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bossDashboard.currencies.map((currency) => (
                              <tr
                                key={currency.currency}
                                className="border-t border-slate-100"
                              >
                                <td className="px-4 py-3 font-semibold">
                                  {currency.currency}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {currency.order_count}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.goods_revenue,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.freight_revenue,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.product_cost,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.additional_cost,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.actual_freight_cost,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right font-semibold tabular-nums text-violet-700">
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.freight_profit,
                                  )}
                                </td>
                                <td
                                  className={`px-4 py-3 text-right font-semibold tabular-nums ${currency.profit_amount < 0 ? "text-rose-700" : "text-emerald-700"}`}
                                >
                                  {formatFinancialMoney(
                                    currency.currency,
                                    currency.profit_amount,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right font-semibold tabular-nums">
                                  {formatPercent(currency.profit_margin)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                        <div className="border-b border-slate-200 px-4 py-3">
                          <h3 className="text-sm font-semibold">
                            最近订单利润
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-400">
                            成本待补的订单显示为暂估，补齐采购价和换算率后自动重算。
                          </p>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[980px] text-sm">
                            <thead className="bg-slate-50 text-left text-xs text-slate-500">
                              <tr>
                                <th className="px-4 py-2.5">订单</th>
                                <th className="px-4 py-2.5">客户 / 业务员</th>
                                <th className="px-4 py-2.5 text-right">
                                  销售额
                                </th>
                                <th className="px-4 py-2.5 text-right">
                                  总成本
                                </th>
                                <th className="px-4 py-2.5 text-right">
                                  运费利润
                                </th>
                                <th className="px-4 py-2.5 text-right">利润</th>
                                <th className="px-4 py-2.5 text-right">
                                  人民币利润
                                </th>
                                <th className="px-4 py-2.5 text-right">
                                  利润率
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {bossDashboard.recent_orders.map((order) => (
                                <tr
                                  key={order.id}
                                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                                  onClick={() => void openOrderByID(order.id)}
                                >
                                  <td className="px-4 py-3">
                                    <div className="font-semibold text-slate-900">
                                      {order.order_no}
                                    </div>
                                    <div className="mt-0.5 max-w-64 truncate text-xs text-slate-400">
                                      {order.title}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div>{order.customer_name}</div>
                                    <div className="mt-0.5 text-xs text-slate-400">
                                      {order.owner_name}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-right tabular-nums">
                                    {formatFinancialMoney(
                                      order.currency,
                                      order.revenue,
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right tabular-nums">
                                    {formatFinancialMoney(
                                      order.currency,
                                      order.total_cost,
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-violet-700">
                                    {formatFinancialMoney(
                                      order.currency,
                                      order.freight_profit,
                                    )}
                                  </td>
                                  <td
                                    className={`px-4 py-3 text-right font-semibold tabular-nums ${order.profit_amount < 0 ? "text-rose-700" : "text-emerald-700"}`}
                                  >
                                    {formatFinancialMoney(
                                      order.currency,
                                      order.profit_amount,
                                    )}
                                    {!order.cost_complete && (
                                      <div className="mt-0.5 text-[10px] font-medium text-amber-600">
                                        暂估
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-700">
                                    {order.cny_complete
                                      ? formatFinancialMoney(
                                          "CNY",
                                          order.profit_amount_cny,
                                        )
                                      : "汇率待补"}
                                  </td>
                                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                                    {formatPercent(order.profit_margin)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>

                      <div className="space-y-4">
                        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                          <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">
                            利润最高
                          </div>
                          <div className="divide-y divide-slate-100">
                            {bossDashboard.top_profit_orders.length === 0 ? (
                              <div className="px-4 py-8 text-center text-xs text-slate-400">
                                暂无成本完整的盈利订单
                              </div>
                            ) : (
                              bossDashboard.top_profit_orders
                                .slice(0, 5)
                                .map((order) => (
                                  <button
                                    key={order.id}
                                    type="button"
                                    onClick={() => void openOrderByID(order.id)}
                                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                                  >
                                    <span className="min-w-0">
                                      <span className="block truncate text-sm font-medium">
                                        {order.order_no} · {order.title}
                                      </span>
                                      <span className="mt-0.5 block text-xs text-slate-400">
                                        {order.customer_name}
                                      </span>
                                    </span>
                                    <span className="shrink-0 text-sm font-semibold text-emerald-700">
                                      {formatFinancialMoney(
                                        order.currency,
                                        order.profit_amount,
                                      )}
                                    </span>
                                  </button>
                                ))
                            )}
                          </div>
                        </section>
                        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                          <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">
                            亏损关注
                          </div>
                          <div className="divide-y divide-slate-100">
                            {bossDashboard.loss_orders_list.length === 0 ? (
                              <div className="px-4 py-8 text-center text-xs text-slate-400">
                                暂无成本完整的亏损订单
                              </div>
                            ) : (
                              bossDashboard.loss_orders_list
                                .slice(0, 5)
                                .map((order) => (
                                  <button
                                    key={order.id}
                                    type="button"
                                    onClick={() => void openOrderByID(order.id)}
                                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                                  >
                                    <span className="min-w-0">
                                      <span className="block truncate text-sm font-medium">
                                        {order.order_no} · {order.title}
                                      </span>
                                      <span className="mt-0.5 block text-xs text-slate-400">
                                        {order.customer_name}
                                      </span>
                                    </span>
                                    <span className="shrink-0 text-sm font-semibold text-rose-700">
                                      {formatFinancialMoney(
                                        order.currency,
                                        order.profit_amount,
                                      )}
                                    </span>
                                  </button>
                                ))
                            )}
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeView === "customers" && (
              <div className="divide-y divide-slate-100">
                {loading ? (
                  <div className="flex h-56 items-center justify-center text-sm text-slate-400">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    加载客户...
                  </div>
                ) : filteredCustomers.length === 0 ? (
                  <div className="flex h-48 items-center justify-center text-sm text-slate-400">
                    没有匹配的客户
                  </div>
                ) : (
                  filteredCustomers.map((customer) => (
                    <div
                      key={customer.id}
                      className="flex flex-col gap-3 px-4 py-3 hover:bg-slate-50/70 md:flex-row md:items-center"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-sm font-semibold text-slate-500">
                          {customer.avatar_url ? (
                            <WhatsAppAvatarImage
                              src={customer.avatar_url}
                              fallback={customer.name.slice(0, 2)}
                            />
                          ) : (
                            customer.name.slice(0, 2)
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-semibold">
                              {customer.name}
                            </span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                              {customer.customer_code}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-slate-400">
                            {customer.company_name} ·{" "}
                            {customer.contact_name ||
                              customer.phone ||
                              customer.email ||
                              "未填写联系人"}
                          </div>
                          {customer.notes && (
                            <div
                              className="mt-1 max-w-xl truncate text-xs text-slate-500"
                              title={customer.notes}
                            >
                              备注：{customer.notes}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-xs text-slate-500 md:w-80">
                        <div>
                          <div className="text-slate-400">负责人</div>
                          <div className="mt-1 font-medium text-slate-700">
                            {customer.owner_name}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-400">业务单</div>
                          <div className="mt-1 font-medium text-slate-700">
                            {customer.open_order_count}/{customer.order_count}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-400">来源</div>
                          <div className="mt-1 font-medium text-slate-700">
                            {SOURCE_LABELS[customer.source]}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        {pendingCustomerDeleteByCustomer.has(customer.id) && (
                          <button
                            type="button"
                            disabled={!tradeAccess?.is_admin}
                            onClick={() => {
                              if (tradeAccess?.is_admin)
                                setCustomerDeleteApprovalsOpen(true);
                            }}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-800 disabled:cursor-default"
                            title={
                              tradeAccess?.is_admin
                                ? "打开客户删除审批"
                                : "等待管理员审批删除"
                            }
                          >
                            <Clock3 className="h-3.5 w-3.5" />
                            待审批
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => viewCustomerOrders(customer)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                          title="查看该客户的全部往来订单"
                        >
                          <History className="h-3.5 w-3.5" />
                          往来订单
                        </button>
                        {customer.channel_id && (
                          <button
                            type="button"
                            onClick={() => openChannel(customer.channel_id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-sky-700 hover:bg-sky-50"
                            title="打开客户频道"
                          >
                            <MessageSquare className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEditCustomer(customer)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                          title="编辑客户资料"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {!pendingCustomerDeleteByCustomer.has(customer.id) && (
                          <button
                            type="button"
                            onClick={() => openCustomerDelete(customer)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50"
                            title={
                              tradeAccess?.is_admin
                                ? "删除客户"
                                : "申请删除客户"
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openOrderModal(customer.id)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          创建询价
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeView === "suppliers" && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-3">供应商</th>
                      <th className="px-4 py-3">联系人</th>
                      <th className="px-4 py-3">电话 / WhatsApp</th>
                      <th className="px-4 py-3">国家</th>
                      <th className="px-4 py-3">默认币种</th>
                      <th className="px-4 py-3">付款方式</th>
                      <th className="px-4 py-3">录入人</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSuppliers.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="h-48 text-center text-slate-400"
                        >
                          暂无供应商，先录入供应商后再进行比价。
                        </td>
                      </tr>
                    ) : (
                      filteredSuppliers.map((supplier) => (
                        <tr
                          key={supplier.id}
                          className="border-t border-slate-100 hover:bg-slate-50/70"
                        >
                          <td className="px-4 py-3">
                            <div className="font-semibold">{supplier.name}</div>
                            <div className="mt-0.5 text-xs text-slate-400">
                              {supplier.supplier_code} · {supplier.company_name}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {supplier.contact_name || "-"}
                          </td>
                          <td className="px-4 py-3">
                            <div>{supplier.phone || "-"}</div>
                            <div className="text-xs text-slate-400">
                              {supplier.whatsapp}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {supplier.country || "-"}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {supplier.default_currency}
                          </td>
                          <td className="px-4 py-3">
                            {supplier.payment_method || "-"}
                          </td>
                          <td className="px-4 py-3">{supplier.owner_name}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>

        {customerModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !savingCustomer) {
                setCustomerModalOpen(false);
                setEditingCustomer(null);
              }
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
                      : "客户建档提示仅供内部员工查看，不会转发给 WhatsApp 客户。"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCustomerModalOpen(false);
                    setEditingCustomer(null);
                  }}
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
                      onClick={() => setCustomerMode("manual")}
                      className={`border-b-2 px-3 py-2 text-sm font-medium ${customerMode === "manual" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400"}`}
                    >
                      手工录入
                    </button>
                    <button
                      type="button"
                      onClick={() => setCustomerMode("whatsapp")}
                      className={`border-b-2 px-3 py-2 text-sm font-medium ${customerMode === "whatsapp" ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-400"}`}
                    >
                      从 WhatsApp 录入
                    </button>
                  </div>
                )}
                {!editingCustomer && customerMode === "whatsapp" && (
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
                            value={whatsAppSearch}
                            onChange={(event) =>
                              setWhatsAppSearch(event.target.value)
                            }
                            placeholder="搜索客户姓名、号码或最近消息"
                            className="min-w-0 flex-1 outline-none"
                          />
                          <span className="text-[11px] text-slate-400">
                            {filteredWhatsAppChats.length}/
                            {whatsAppChats.length}
                          </span>
                        </label>
                        <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-emerald-100 bg-white">
                          {filteredWhatsAppChats.map((chat) => {
                            const selected =
                              customerDraft.whatsapp_chat_id === chat.id;
                            return (
                              <button
                                key={chat.id}
                                type="button"
                                onClick={() => chooseWhatsAppChat(chat)}
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
                  <label className="text-sm font-medium text-slate-700">
                    客户简称<span className="text-rose-500"> *</span>
                    <input
                      value={customerDraft.name}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    公司全称
                    <input
                      value={customerDraft.company_name}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          company_name: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    联系人
                    <input
                      value={customerDraft.contact_name}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          contact_name: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    电话 / WhatsApp
                    <input
                      value={customerDraft.phone}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          phone: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    邮箱
                    <input
                      value={customerDraft.email}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          email: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    国家/地区
                    <input
                      value={customerDraft.country}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          country: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    州/省/地区
                    <input
                      value={customerDraft.region}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          region: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    客户来源
                    <select
                      value={customerDraft.source}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          source: event.target.value as TradeCustomer["source"],
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 outline-none"
                    >
                      {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    客户等级
                    <select
                      value={customerDraft.customer_level}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          customer_level: event.target
                            .value as TradeCustomer["customer_level"],
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 outline-none"
                    >
                      <option value="A">A · 重点客户</option>
                      <option value="B">B · 普通客户</option>
                      <option value="C">C · 潜在客户</option>
                    </select>
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    客户状态
                    <select
                      value={customerDraft.status}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          status: event.target.value as TradeCustomer["status"],
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 outline-none"
                    >
                      {Object.entries(CUSTOMER_STATUS_LABELS).map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                    标签
                    <input
                      value={customerDraft.tags}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          tags: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                      placeholder="批发商, 欧洲, 重点跟进"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                    备注
                    <textarea
                      value={customerDraft.notes}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          notes: event.target.value,
                        }))
                      }
                      className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 outline-none"
                    />
                  </label>
                </div>
                {!editingCustomer && (
                  <label className="mt-4 flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={customerDraft.create_channel}
                      onChange={(event) =>
                        setCustomerDraft((current) => ({
                          ...current,
                          create_channel: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-slate-900"
                    />
                    <span>
                      <span className="font-medium">自动建立客户频道</span>
                      <span className="ml-2 text-xs text-slate-400">
                        用于沟通、文件和业务协作
                      </span>
                    </span>
                  </label>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setCustomerModalOpen(false);
                    setEditingCustomer(null);
                  }}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveCustomer()}
                  disabled={savingCustomer || !customerDraft.name.trim()}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingCustomer && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {editingCustomer ? "保存修改" : "保存客户"}
                </button>
              </div>
            </div>
          </div>
        )}

        {customerDeleteApprovalsOpen && tradeAccess?.is_admin && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget)
                setCustomerDeleteApprovalsOpen(false);
            }}
          >
            <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">客户删除审批</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    只有管理员同意后客户档案才会删除，历史订单和客户频道继续保留。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomerDeleteApprovalsOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {customerDeleteRequests.length === 0 ? (
                  <div className="flex h-40 flex-col items-center justify-center text-sm text-slate-400">
                    <ShieldCheck className="mb-2 h-7 w-7 text-emerald-500" />
                    暂无待审批的客户删除申请
                  </div>
                ) : (
                  <div className="space-y-3">
                    {customerDeleteRequests.map((request) => (
                      <div
                        key={request.id}
                        className="rounded-lg border border-slate-200 p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900">
                                {request.customer_name}
                              </span>
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                                {request.customer_code}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              申请人：{request.requester_name || "账号已删除"} ·{" "}
                              {formatDate(request.requested_at)}
                            </div>
                            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
                              {request.reason || "未填写删除原因"}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void rejectCustomerDelete(request)}
                              disabled={decidingCustomerDeleteID === request.id}
                              className="h-9 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                            >
                              拒绝
                            </button>
                            <button
                              type="button"
                              onClick={() => approveCustomerDelete(request)}
                              disabled={decidingCustomerDeleteID === request.id}
                              className="inline-flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-3 text-sm font-semibold text-white disabled:opacity-40"
                            >
                              <Trash2 className="h-4 w-4" />
                              同意删除
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex justify-end border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setCustomerDeleteApprovalsOpen(false)}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600"
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        )}

        {customerDeleteTarget && (
          <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deletingCustomer)
                setCustomerDeleteTarget(null);
            }}
          >
            <div className="w-full max-w-lg overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">
                    {tradeAccess?.is_admin
                      ? "确认删除客户"
                      : "申请删除客户"}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {customerDeleteTarget.customer_code} ·{" "}
                    {customerDeleteTarget.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomerDeleteTarget(null)}
                  disabled={deletingCustomer}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-4 p-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-900">
                  {tradeAccess?.is_admin
                    ? `删除后客户不会再出现在客户列表，也不能用于新建询价；已有 ${customerDeleteTarget.order_count} 个历史订单及客户频道会继续保留。`
                    : "提交后不会立即删除，需要管理员查看原因并同意。审批前客户资料仍可正常使用。"}
                </div>
                {tradeAccess?.is_admin &&
                  pendingCustomerDeleteByCustomer.get(
                    customerDeleteTarget.id,
                  ) && (
                    <div className="rounded-lg border border-slate-200 px-3 py-3 text-sm text-slate-600">
                      <div className="text-xs font-semibold text-slate-400">
                        员工申请原因
                      </div>
                      <div className="mt-1 leading-6">
                        {
                          pendingCustomerDeleteByCustomer.get(
                            customerDeleteTarget.id,
                          )?.reason
                        }
                      </div>
                    </div>
                  )}
                {!tradeAccess?.is_admin && (
                  <label className="block text-sm font-medium text-slate-700">
                    删除原因<span className="text-rose-500"> *</span>
                    <textarea
                      value={customerDeleteReason}
                      onChange={(event) =>
                        setCustomerDeleteReason(event.target.value)
                      }
                      className="mt-1.5 min-h-28 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-slate-400"
                      placeholder="说明客户重复、录入错误或不再使用等原因"
                    />
                  </label>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setCustomerDeleteTarget(null)}
                  disabled={deletingCustomer}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void submitCustomerDelete()}
                  disabled={
                    deletingCustomer ||
                    (!tradeAccess?.is_admin && !customerDeleteReason.trim())
                  }
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {deletingCustomer ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  {tradeAccess?.is_admin ? "确认删除" : "提交申请"}
                </button>
              </div>
            </div>
          </div>
        )}

        {orderModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !savingOrder)
                setOrderModalOpen(false);
            }}
          >
            <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">新建客户询价</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    保存后生成九张流程工作表，并按职位推送下一步任务。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOrderModalOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                    客户<span className="text-rose-500"> *</span>
                    <select
                      value={orderDraft.customer_id}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          customer_id: Number(event.target.value),
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 outline-none"
                    >
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name} · {customer.company_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                    询价主题<span className="text-rose-500"> *</span>
                    <input
                      value={orderDraft.title}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                      placeholder="例如 2026 秋季五金产品询价"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    优先级
                    <select
                      value={orderDraft.priority}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          priority: event.target
                            .value as TradeOrder["priority"],
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 outline-none"
                    >
                      {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    报价截止
                    <input
                      type="date"
                      value={orderDraft.quote_deadline}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          quote_deadline: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    币种
                    <input
                      list="trade-currency-options"
                      value={orderDraft.currency}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          currency: event.target.value.toUpperCase(),
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 uppercase outline-none"
                      placeholder="输入代码或搜索币种"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    付款方式
                    <input
                      list="trade-payment-options"
                      value={orderDraft.payment_method}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          payment_method: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    目的国家
                    <input
                      value={orderDraft.destination_country}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          destination_country: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    目的港
                    <input
                      value={orderDraft.destination_port}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          destination_port: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                </div>
                <div className="mt-6 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">询价产品</h3>
                    <p className="mt-0.5 text-xs text-slate-400">
                      产品资料会贯穿供应商询价、报价、采购、到货、质检和装箱。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setOrderItems((current) => [...current, newOrderItem()])
                    }
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加产品
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {orderItems.map((item, index) => (
                    <div
                      key={index}
                      className="relative grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-12"
                    >
                      <div className="absolute -left-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
                        {index + 1}
                      </div>
                      <input
                        value={item.sku}
                        onChange={(event) =>
                          updateOrderItem(index, "sku", event.target.value)
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none lg:col-span-2"
                        placeholder="SKU"
                      />
                      <input
                        value={item.product_name}
                        onChange={(event) =>
                          updateOrderItem(
                            index,
                            "product_name",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none lg:col-span-3"
                        placeholder="产品名称 *"
                      />
                      <input
                        value={item.specification}
                        onChange={(event) =>
                          updateOrderItem(
                            index,
                            "specification",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none lg:col-span-3"
                        placeholder="规格/材质/颜色"
                      />
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={item.quantity}
                        onChange={(event) =>
                          updateOrderItem(index, "quantity", event.target.value)
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none lg:col-span-1"
                        placeholder="数量"
                      />
                      <input
                        value={item.unit}
                        onChange={(event) =>
                          updateOrderItem(index, "unit", event.target.value)
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none lg:col-span-1"
                        placeholder="单位"
                      />
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={item.target_price}
                        onChange={(event) =>
                          updateOrderItem(
                            index,
                            "target_price",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none lg:col-span-1"
                        placeholder="目标价"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setOrderItems((current) =>
                            current.length === 1
                              ? [newOrderItem()]
                              : current.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                          )
                        }
                        className="inline-flex h-9 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 lg:col-span-1"
                        title="删除产品"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <input
                        value={item.description}
                        onChange={(event) =>
                          updateOrderItem(
                            index,
                            "description",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none sm:col-span-2 lg:col-span-12"
                        placeholder="客户要求、包装或其他说明"
                      />
                    </div>
                  ))}
                </div>
                <label className="mt-4 block text-sm font-medium text-slate-700">
                  业务备注
                  <textarea
                    value={orderDraft.notes}
                    onChange={(event) =>
                      setOrderDraft((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                    className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 outline-none"
                  />
                </label>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <label className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={orderDraft.create_workspace}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          create_workspace: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-slate-900"
                    />
                    <span>
                      <span className="font-medium">生成流程工作簿</span>
                      <span className="ml-2 text-xs text-slate-400">
                        九张标准工作表
                      </span>
                    </span>
                  </label>
                  <label className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={orderDraft.shared_workspace}
                      disabled={!orderDraft.create_workspace}
                      onChange={(event) =>
                        setOrderDraft((current) => ({
                          ...current,
                          shared_workspace: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-slate-900"
                    />
                    <span>
                      <span className="font-medium">内部共享编辑</span>
                      <span className="ml-2 text-xs text-slate-400">
                        工作表修改自动写回 ERP
                      </span>
                    </span>
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setOrderModalOpen(false)}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveOrder()}
                  disabled={savingOrder}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingOrder && <Loader2 className="h-4 w-4 animate-spin" />}
                  创建业务单
                </button>
              </div>
            </div>
          </div>
        )}

        {supplierModalOpen && (
          <div
            className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !savingSupplier)
                setSupplierModalOpen(false);
            }}
          >
            <div className="w-full max-w-2xl rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">录入供应商</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    供应商可在多个业务单的询价和采购环节复用。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSupplierModalOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[75vh] overflow-y-auto p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-medium">
                    供应商简称 *
                    <input
                      value={supplierDraft.name}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    公司全称
                    <input
                      value={supplierDraft.company_name}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          company_name: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    联系人
                    <input
                      value={supplierDraft.contact_name}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          contact_name: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    电话
                    <input
                      value={supplierDraft.phone}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          phone: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    WhatsApp
                    <input
                      value={supplierDraft.whatsapp}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          whatsapp: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    邮箱
                    <input
                      value={supplierDraft.email}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          email: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    国家/地区
                    <input
                      value={supplierDraft.country}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          country: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    默认币种
                    <input
                      list="trade-currency-options"
                      value={supplierDraft.default_currency}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          default_currency: event.target.value.toUpperCase(),
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 uppercase outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium sm:col-span-2">
                    付款方式
                    <input
                      list="trade-payment-options"
                      value={supplierDraft.payment_method}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          payment_method: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium sm:col-span-2">
                    备注
                    <textarea
                      value={supplierDraft.notes}
                      onChange={(event) =>
                        setSupplierDraft((current) => ({
                          ...current,
                          notes: event.target.value,
                        }))
                      }
                      className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                    />
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setSupplierModalOpen(false)}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveSupplier()}
                  disabled={savingSupplier}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingSupplier && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  保存供应商
                </button>
              </div>
            </div>
          </div>
        )}

        {quoteModalOpen && detailOrder && (
          <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
            <div className="w-full max-w-2xl rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">录入供应商报价</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    报价保存后会写入“供应商询价”工作表。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setQuoteModalOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="text-sm font-medium">
                    <div className="flex items-center justify-between gap-2">
                      <span>产品</span>
                      {detailOrder.access?.can_add_items && (
                        <button
                          type="button"
                          onClick={openAddItems}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          添加产品
                        </button>
                      )}
                    </div>
                    <select
                      value={quoteDraft.order_item_id}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          order_item_id: Number(event.target.value),
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3"
                    >
                      {(detailOrder.items || []).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.line_no}. {item.sku || item.product_name} ·{" "}
                          {item.product_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="text-sm font-medium">
                    <div>供应商</div>
                    <div className="mt-1.5 flex gap-2">
                      <SupplierCombobox
                        suppliers={suppliers}
                        value={quoteDraft.supplier_id}
                        onChange={(supplierID, supplier) =>
                          setQuoteDraft((current) => ({
                            ...current,
                            supplier_id: supplierID,
                            currency:
                              supplier.default_currency ||
                              current.currency ||
                              detailOrder.currency,
                          }))
                        }
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setSupplierDraft(newSupplierDraft(paymentOptions[0]));
                          setSupplierModalOpen(true);
                        }}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200"
                        title="新增供应商"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <label className="text-sm font-medium">
                    币种
                    <input
                      list="trade-currency-options"
                      value={quoteDraft.currency}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          currency: event.target.value.toUpperCase(),
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 uppercase"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    供应商单价
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={quoteDraft.unit_price}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          unit_price: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    MOQ
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={quoteDraft.moq}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          moq: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    交期/天
                    <input
                      type="number"
                      min="0"
                      value={quoteDraft.lead_time_days}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          lead_time_days: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    报价有效期
                    <input
                      type="date"
                      value={quoteDraft.valid_until}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          valid_until: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3"
                    />
                  </label>
                  <label className="text-sm font-medium sm:col-span-2">
                    供应商备注
                    <textarea
                      value={quoteDraft.notes}
                      onChange={(event) =>
                        setQuoteDraft((current) => ({
                          ...current,
                          notes: event.target.value,
                        }))
                      }
                      className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2"
                    />
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setQuoteModalOpen(false)}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveSupplierQuote()}
                  disabled={savingQuote}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingQuote && <Loader2 className="h-4 w-4 animate-spin" />}
                  保存报价
                </button>
              </div>
            </div>
          </div>
        )}

        {customerQuoteModalOpen && detailOrder && customerQuoteDraft && (
          <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4">
            <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">新建对客报价轮次</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {detailOrder.order_no} ·
                    保存后保留本轮版本，客户砍价时可基于本轮重新报价。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomerQuoteModalOpen(false)}
                  disabled={savingCustomerQuote}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="text-sm font-medium">
                    报价币种
                    <input
                      list="trade-currency-options"
                      value={customerQuoteDraft.currency}
                      onChange={(event) =>
                        setCustomerQuoteDraft((current) =>
                          current
                            ? {
                                ...current,
                                currency: event.target.value.toUpperCase(),
                                exchange_rate_cny:
                                  event.target.value.toUpperCase() === "CNY"
                                    ? "1"
                                    : current.currency === "CNY"
                                      ? ""
                                      : current.exchange_rate_cny,
                              }
                            : current,
                        )
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 uppercase outline-none"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    兑人民币汇率
                    <input
                      type="number"
                      min="0"
                      step="any"
                      disabled={customerQuoteDraft.currency === "CNY"}
                      value={
                        customerQuoteDraft.currency === "CNY"
                          ? "1"
                          : customerQuoteDraft.exchange_rate_cny
                      }
                      onChange={(event) =>
                        setCustomerQuoteDraft((current) =>
                          current
                            ? {
                                ...current,
                                exchange_rate_cny: event.target.value,
                              }
                            : current,
                        )
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none disabled:bg-slate-100"
                      placeholder={`1 ${customerQuoteDraft.currency} = ? CNY`}
                    />
                  </label>
                  <label className="text-sm font-medium">
                    运费方式
                    <select
                      value={customerQuoteDraft.freight_mode}
                      onChange={(event) =>
                        setCustomerQuoteDraft((current) =>
                          current
                            ? {
                                ...current,
                                freight_mode: event.target.value as
                                  "customer_forwarder" | "quoted",
                                freight_amount:
                                  event.target.value === "quoted"
                                    ? current.freight_amount
                                    : "",
                              }
                            : current,
                        )
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3"
                    >
                      <option value="customer_forwarder">
                        客户自有货代，不报价运费
                      </option>
                      <option value="quoted">我方报价运费</option>
                    </select>
                  </label>
                  <label className="text-sm font-medium">
                    保存状态
                    <select
                      value={customerQuoteDraft.status}
                      onChange={(event) =>
                        setCustomerQuoteDraft((current) =>
                          current
                            ? {
                                ...current,
                                status: event.target.value as "draft" | "sent",
                              }
                            : current,
                        )
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3"
                    >
                      <option value="sent">已向客户报价</option>
                      <option value="draft">仅保存草稿</option>
                    </select>
                  </label>
                </div>
                {customerQuoteDraft.freight_mode === "quoted" && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium">
                      报价运费（{customerQuoteDraft.currency}）
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={customerQuoteDraft.freight_amount}
                        onChange={(event) =>
                          setCustomerQuoteDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  freight_amount: event.target.value,
                                }
                              : current,
                          )
                        }
                        className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none focus:border-sky-400"
                        placeholder="向客户收取的运费"
                      />
                    </label>
                    <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
                      报价运费会保留在本轮报价中。发货时录入最终实际运费，系统会单独计算运费利润。
                    </div>
                  </div>
                )}
                <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-3 py-2">产品</th>
                        <th className="px-3 py-2 text-right">数量</th>
                        {detailOrder.access?.can_view_supplier_pricing && (
                          <th className="px-3 py-2 text-right">采购参考价</th>
                        )}
                        <th className="px-3 py-2 text-right">本轮对客单价</th>
                        <th className="px-3 py-2 text-right">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customerQuoteDraft.items.map((item) => {
                        const orderItem = (detailOrder.items || []).find(
                          (candidate) => candidate.id === item.order_item_id,
                        );
                        const unitPrice = Number(item.unit_price || 0);
                        return (
                          <tr
                            key={item.order_item_id}
                            className="border-t border-slate-100"
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium">
                                {item.sku || item.product_name}
                              </div>
                              <div className="text-xs text-slate-400">
                                {item.product_name}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">
                              {item.quantity} {item.unit}
                            </td>
                            {detailOrder.access?.can_view_supplier_pricing && (
                              <td className="px-3 py-2 text-right text-slate-500">
                                {formatMoney(
                                  orderItem?.purchase_currency ||
                                    customerQuoteDraft.currency,
                                  orderItem?.purchase_price || 0,
                                )}
                              </td>
                            )}
                            <td className="px-3 py-2 text-right">
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={item.unit_price}
                                onChange={(event) =>
                                  updateCustomerQuoteItemPrice(
                                    item.order_item_id,
                                    event.target.value,
                                  )
                                }
                                className="h-9 w-32 rounded-lg border border-slate-200 px-3 text-right outline-none focus:border-sky-400"
                                placeholder="必填"
                              />
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-700">
                              {formatMoney(
                                customerQuoteDraft.currency,
                                unitPrice * item.quantity,
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="border-t border-slate-200 bg-slate-50">
                      <tr>
                        <td
                          colSpan={
                            detailOrder.access?.can_view_supplier_pricing
                              ? 4
                              : 3
                          }
                          className="px-3 py-2 text-right text-xs font-semibold text-slate-500"
                        >
                          商品金额
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-700">
                          {formatFinancialMoney(
                            customerQuoteDraft.currency,
                            customerQuoteAmounts.goods,
                          )}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-200/70">
                        <td
                          colSpan={
                            detailOrder.access?.can_view_supplier_pricing
                              ? 4
                              : 3
                          }
                          className="px-3 py-2 text-right text-xs font-semibold text-slate-500"
                        >
                          报价运费
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-700">
                          {customerQuoteDraft.freight_mode ===
                          "customer_forwarder"
                            ? "客户自有货代"
                            : formatFinancialMoney(
                                customerQuoteDraft.currency,
                                customerQuoteAmounts.freight,
                              )}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-200/70">
                        <td
                          colSpan={
                            detailOrder.access?.can_view_supplier_pricing
                              ? 4
                              : 3
                          }
                          className="px-3 py-2 text-right text-xs font-semibold text-slate-600"
                        >
                          本轮报价合计
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-sky-700">
                          {formatFinancialMoney(
                            customerQuoteDraft.currency,
                            customerQuoteAmounts.total,
                          )}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-200/70">
                        <td
                          colSpan={
                            detailOrder.access?.can_view_supplier_pricing
                              ? 4
                              : 3
                          }
                          className="px-3 py-2 text-right text-xs font-semibold text-slate-500"
                        >
                          折合人民币
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-rose-700">
                          {customerQuoteAmounts.totalCNY > 0
                            ? formatFinancialMoney(
                                "CNY",
                                customerQuoteAmounts.totalCNY,
                              )
                            : "待填写汇率"}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm font-medium">
                    客户反馈或本轮议价依据
                    <textarea
                      value={customerQuoteDraft.customer_feedback}
                      onChange={(event) =>
                        setCustomerQuoteDraft((current) =>
                          current
                            ? {
                                ...current,
                                customer_feedback: event.target.value,
                              }
                            : current,
                        )
                      }
                      className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                      placeholder="例如：客户希望总价降低 5%，或指定某个 SKU 的目标价"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    内部备注
                    <textarea
                      value={customerQuoteDraft.notes}
                      onChange={(event) =>
                        setCustomerQuoteDraft((current) =>
                          current
                            ? { ...current, notes: event.target.value }
                            : current,
                        )
                      }
                      className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                      placeholder="利润、审批或报价策略说明，仅内部可见"
                    />
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setCustomerQuoteModalOpen(false)}
                  disabled={savingCustomerQuote}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveCustomerQuoteRound()}
                  disabled={savingCustomerQuote}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
                >
                  {savingCustomerQuote && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  保存本轮报价
                </button>
              </div>
            </div>
          </div>
        )}

        {customerQuoteStatusDraft && detailOrder && (
          <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4">
            <div className="w-full max-w-lg rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">更新客户反馈</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    第 {customerQuoteStatusDraft.quote.round_no} 轮报价 ·{" "}
                    {formatMoney(
                      customerQuoteStatusDraft.quote.currency,
                      customerQuoteStatusDraft.quote.total_amount,
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomerQuoteStatusDraft(null)}
                  disabled={savingCustomerQuoteStatus}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 p-4">
                <label className="block text-sm font-medium">
                  当前结果
                  <select
                    value={customerQuoteStatusDraft.status}
                    onChange={(event) =>
                      setCustomerQuoteStatusDraft((current) =>
                        current
                          ? {
                              ...current,
                              status: event.target
                                .value as CustomerQuoteStatusDraft["status"],
                            }
                          : current,
                      )
                    }
                    className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3"
                  >
                    <option value="sent">已向客户报价</option>
                    <option value="negotiating">客户议价中</option>
                    <option value="accepted">客户已接受</option>
                    <option value="rejected">客户已拒绝</option>
                  </select>
                </label>
                <label className="block text-sm font-medium">
                  客户反馈
                  <textarea
                    value={customerQuoteStatusDraft.customer_feedback}
                    onChange={(event) =>
                      setCustomerQuoteStatusDraft((current) =>
                        current
                          ? {
                              ...current,
                              customer_feedback: event.target.value,
                            }
                          : current,
                      )
                    }
                    className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                    placeholder="客户砍价时请填写目标价、降价幅度或具体要求"
                  />
                </label>
                <label className="block text-sm font-medium">
                  内部备注
                  <textarea
                    value={customerQuoteStatusDraft.notes}
                    onChange={(event) =>
                      setCustomerQuoteStatusDraft((current) =>
                        current
                          ? { ...current, notes: event.target.value }
                          : current,
                      )
                    }
                    className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                  />
                </label>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setCustomerQuoteStatusDraft(null)}
                  disabled={savingCustomerQuoteStatus}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveCustomerQuoteStatus()}
                  disabled={savingCustomerQuoteStatus}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingCustomerQuoteStatus && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  保存状态
                </button>
              </div>
            </div>
          </div>
        )}

        {itemModalOpen && detailOrder && (
          <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4">
            <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">向业务单添加产品</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {detailOrder.order_no} ·
                    新产品会同步到当前流程工作簿，并可立即录入供应商报价。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setItemModalOpen(false)}
                  disabled={savingItems}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">追加产品明细</h3>
                    <p className="mt-0.5 text-xs text-slate-400">
                      产品名称和数量为必填项，可一次添加多行。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setAdditionalItems((current) => [
                        ...current,
                        newOrderItem(),
                      ])
                    }
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加一行
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {additionalItems.map((item, index) => (
                    <div
                      key={index}
                      className="relative grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-12"
                    >
                      <div className="absolute -left-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-[11px] font-semibold text-white">
                        {index + 1}
                      </div>
                      <input
                        value={item.sku}
                        onChange={(event) =>
                          updateAdditionalItem(index, "sku", event.target.value)
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 lg:col-span-2"
                        placeholder="SKU"
                      />
                      <input
                        value={item.product_name}
                        onChange={(event) =>
                          updateAdditionalItem(
                            index,
                            "product_name",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 lg:col-span-3"
                        placeholder="产品名称 *"
                      />
                      <input
                        value={item.specification}
                        onChange={(event) =>
                          updateAdditionalItem(
                            index,
                            "specification",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 lg:col-span-3"
                        placeholder="规格/材质/颜色"
                      />
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={item.quantity}
                        onChange={(event) =>
                          updateAdditionalItem(
                            index,
                            "quantity",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 lg:col-span-1"
                        placeholder="数量"
                      />
                      <input
                        value={item.unit}
                        onChange={(event) =>
                          updateAdditionalItem(
                            index,
                            "unit",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 lg:col-span-1"
                        placeholder="单位"
                      />
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={item.target_price}
                        onChange={(event) =>
                          updateAdditionalItem(
                            index,
                            "target_price",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 lg:col-span-1"
                        placeholder="目标价"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setAdditionalItems((current) =>
                            current.length === 1
                              ? [newOrderItem()]
                              : current.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                          )
                        }
                        className="inline-flex h-9 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 lg:col-span-1"
                        title="删除这一行"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <input
                        value={item.description}
                        onChange={(event) =>
                          updateAdditionalItem(
                            index,
                            "description",
                            event.target.value,
                          )
                        }
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 sm:col-span-2 lg:col-span-12"
                        placeholder="客户要求、包装或其他说明"
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setItemModalOpen(false)}
                  disabled={savingItems}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveAdditionalItems()}
                  disabled={savingItems}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
                >
                  {savingItems && <Loader2 className="h-4 w-4 animate-spin" />}
                  保存并同步
                </button>
              </div>
            </div>
          </div>
        )}

        {settingsOpen && (
          <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
            <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">外贸流程设置</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    职位支持一人多岗，订单进入下一阶段时会通知对应职位员工。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex border-b border-slate-200 px-4">
                <button
                  type="button"
                  onClick={() => setSettingsTab("positions")}
                  className={`border-b-2 px-3 py-3 text-sm font-medium ${settingsTab === "positions" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400"}`}
                >
                  职位与交接
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("payments")}
                  className={`border-b-2 px-3 py-3 text-sm font-medium ${settingsTab === "payments" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400"}`}
                >
                  付款方式
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("pi")}
                  className={`border-b-2 px-3 py-3 text-sm font-medium ${settingsTab === "pi" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400"}`}
                >
                  PI 抬头与收款
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {settingsTab === "positions" ? (
                  <>
                    <label className="mb-3 flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-500">
                      <Search className="h-4 w-4" />
                      <input
                        value={positionUserSearch}
                        onChange={(event) =>
                          setPositionUserSearch(event.target.value)
                        }
                        placeholder="搜索员工后分配职位"
                        className="min-w-0 flex-1 outline-none"
                      />
                    </label>
                    <div className="space-y-2">
                      {positions.map((position) => {
                        const selectedIDs = positionsDraft[position.code] || [];
                        return (
                          <div
                            key={position.id}
                            className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[180px_1fr]"
                          >
                            <div>
                              <div className="text-sm font-semibold">
                                {position.name}
                              </div>
                              <div className="mt-1 text-xs leading-5 text-slate-400">
                                {stageDefinition(position.stage)?.label} ·{" "}
                                {position.description}
                              </div>
                            </div>
                            <div>
                              <div className="flex flex-wrap gap-1.5">
                                {selectedIDs.length === 0 ? (
                                  <span className="text-xs text-amber-600">
                                    未分配时由业务单负责人兜底处理
                                  </span>
                                ) : (
                                  selectedIDs.map((userID) => {
                                    const user =
                                      users.find(
                                        (item) => item.id === userID,
                                      ) ||
                                      position.members.find(
                                        (member) => member.user_id === userID,
                                      );
                                    return (
                                      <button
                                        key={userID}
                                        type="button"
                                        onClick={() =>
                                          setPositionsDraft((current) => ({
                                            ...current,
                                            [position.code]: selectedIDs.filter(
                                              (id) => id !== userID,
                                            ),
                                          }))
                                        }
                                        className="inline-flex h-7 items-center gap-1 rounded-md bg-slate-100 px-2 text-xs font-medium text-slate-700"
                                        title="移除此职位"
                                      >
                                        {user?.username || `员工 #${userID}`}
                                        <X className="h-3 w-3" />
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                              <select
                                value=""
                                onChange={(event) => {
                                  const userID = Number(event.target.value);
                                  if (!userID || selectedIDs.includes(userID))
                                    return;
                                  setPositionsDraft((current) => ({
                                    ...current,
                                    [position.code]: [...selectedIDs, userID],
                                  }));
                                }}
                                className="mt-2 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                              >
                                <option value="">添加员工到此职位...</option>
                                {filteredPositionUsers
                                  .filter(
                                    (user) => !selectedIDs.includes(user.id),
                                  )
                                  .map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.username} · {user.email}
                                    </option>
                                  ))}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : settingsTab === "payments" ? (
                  <div>
                    <label className="block text-sm font-medium">
                      常用付款方式
                      <textarea
                        value={paymentMethodsText}
                        onChange={(event) =>
                          setPaymentMethodsText(event.target.value)
                        }
                        className="mt-2 min-h-64 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-7 outline-none"
                        placeholder="每行一种付款方式"
                      />
                    </label>
                    <p className="mt-2 text-xs text-slate-400">
                      每行一种，保存后会出现在客户询价和供应商资料的可搜索选项中。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">
                        卖方资料
                      </h3>
                      <p className="mt-1 text-xs text-slate-400">
                        这些资料会显示在发送给客户的 Proforma Invoice 中。
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        [
                          "company_name",
                          "公司英文名称",
                          "YAERP Trading Co., Ltd.",
                        ],
                        ["contact_name", "联系人", "Sales Department"],
                        ["phone", "电话", "+86 ..."],
                        ["email", "邮箱", "sales@example.com"],
                        ["tax_id", "税号 / 注册号", "Registration No."],
                        ["account_name", "收款账户名称", "Beneficiary name"],
                      ].map(([key, label, placeholder]) => (
                        <label key={key} className="block">
                          <span className="mb-1.5 block text-xs font-medium text-slate-600">
                            {label}
                          </span>
                          <input
                            value={piProfileDraft[key as keyof TradePIProfile]}
                            onChange={(event) =>
                              setPIProfileDraft((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }))
                            }
                            placeholder={placeholder}
                            className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                          />
                        </label>
                      ))}
                    </div>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        公司地址
                      </span>
                      <input
                        value={piProfileDraft.address}
                        onChange={(event) =>
                          setPIProfileDraft((current) => ({
                            ...current,
                            address: event.target.value,
                          }))
                        }
                        placeholder="Seller address"
                        className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      />
                    </label>
                    <div className="border-t border-slate-200 pt-5">
                      <h3 className="text-sm font-semibold text-slate-900">
                        收款银行
                      </h3>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {[
                          ["bank_name", "银行名称", "Bank name"],
                          ["swift_code", "SWIFT / BIC", "SWIFT code"],
                          ["account_number", "账号 / IBAN", "Account number"],
                          ["bank_address", "银行地址", "Bank address"],
                          [
                            "beneficiary_address",
                            "收款人地址",
                            "Beneficiary address",
                          ],
                        ].map(([key, label, placeholder]) => (
                          <label
                            key={key}
                            className={
                              key === "beneficiary_address"
                                ? "block sm:col-span-2"
                                : "block"
                            }
                          >
                            <span className="mb-1.5 block text-xs font-medium text-slate-600">
                              {label}
                            </span>
                            <input
                              value={
                                piProfileDraft[key as keyof TradePIProfile]
                              }
                              onChange={(event) =>
                                setPIProfileDraft((current) => ({
                                  ...current,
                                  [key]: event.target.value,
                                }))
                              }
                              placeholder={placeholder}
                              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        PI 默认备注
                      </span>
                      <textarea
                        value={piProfileDraft.default_notes}
                        onChange={(event) =>
                          setPIProfileDraft((current) => ({
                            ...current,
                            default_notes: event.target.value,
                          }))
                        }
                        className="min-h-24 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                        placeholder="Bank charges, validity, warranty or other standard notes"
                      />
                    </label>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void (settingsTab === "positions"
                      ? savePositionAssignments()
                      : saveTradeSettings())
                  }
                  disabled={savingSettings}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingSettings ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存设置
                </button>
              </div>
            </div>
          </div>
        )}

        {detailOrder && (
          <div
            className="fixed inset-0 z-40 bg-slate-950/35"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !flowing)
                closeOrderDetail();
            }}
          >
            <aside className="absolute inset-y-0 right-0 flex w-full max-w-5xl flex-col bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-4">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-400">
                    {detailOrder.order_no}
                  </div>
                  <h2 className="mt-1 truncate text-lg font-semibold">
                    {detailOrder.title}
                  </h2>
                  <div className="mt-1 text-sm text-slate-500">
                    {detailOrder.access?.can_view_customer
                      ? `${detailOrder.customer_name} · ${detailOrder.customer_company}`
                      : detailOrder.access?.scope_label || "受限任务视图"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeOrderDetail}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {detailLoading ? (
                  <div className="flex h-72 items-center justify-center text-sm text-slate-400">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    加载业务单详情...
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto border-b border-slate-200 px-4 py-4">
                      <div className="flex min-w-[900px] items-start">
                        {STAGES.map((stage, index) => {
                          const currentIndex = STAGES.findIndex(
                            (item) => item.key === detailOrder.stage,
                          );
                          const done =
                            detailOrder.stage === "completed" ||
                            (currentIndex >= 0 && index < currentIndex);
                          const active = stage.key === detailOrder.stage;
                          const Icon = stage.icon;
                          return (
                            <div
                              key={stage.key}
                              className="relative flex flex-1 flex-col items-center"
                            >
                              <div
                                className={`absolute left-0 right-0 top-4 h-0.5 ${index === 0 ? "left-1/2" : ""} ${index === STAGES.length - 1 ? "right-1/2" : ""} ${done || active ? "bg-emerald-400" : "bg-slate-200"}`}
                              />
                              <div
                                className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 ${done ? "border-emerald-500 bg-emerald-500 text-white" : active ? "border-slate-900 bg-white text-slate-900" : "border-slate-200 bg-white text-slate-300"}`}
                              >
                                {done ? (
                                  <Check className="h-4 w-4" />
                                ) : (
                                  <Icon className="h-3.5 w-3.5" />
                                )}
                              </div>
                              <div
                                className={`mt-2 text-xs font-medium ${active ? "text-slate-900" : done ? "text-emerald-700" : "text-slate-400"}`}
                              >
                                {stage.shortLabel}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {detailOrder.access && (
                      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-600">
                        {detailOrder.access.scope_label} · 可查看{" "}
                        {detailOrder.access.visible_sheet_names.length}{" "}
                        张流程工作表
                        {detailOrder.access.editable_sheet_names.length > 0 &&
                          `，可编辑 ${detailOrder.access.editable_sheet_names.join("、")}`}
                      </div>
                    )}
                    <div className="grid gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-4">
                      <div className="bg-white px-4 py-3">
                        <div className="text-xs text-slate-400">币种</div>
                        <div className="mt-1 text-sm font-semibold">
                          {detailOrder.access?.can_view_customer_pricing ||
                          detailOrder.access?.can_view_supplier_pricing
                            ? detailOrder.currency
                            : "按岗位隐藏"}
                        </div>
                      </div>
                      <div className="bg-white px-4 py-3">
                        <div className="text-xs text-slate-400">付款方式</div>
                        <div className="mt-1 text-sm font-semibold">
                          {detailOrder.access?.can_view_customer_pricing
                            ? detailOrder.payment_method ||
                              detailOrder.payment_terms ||
                              "未设置"
                            : "按岗位隐藏"}
                        </div>
                      </div>
                      <div className="bg-white px-4 py-3">
                        <div className="text-xs text-slate-400">目的地</div>
                        <div className="mt-1 text-sm font-semibold">
                          {detailOrder.access?.can_view_customer ||
                          detailOrder.access?.can_view_shipment
                            ? `${detailOrder.destination_country || "未设置"} ${detailOrder.destination_port}`
                            : "按岗位隐藏"}
                        </div>
                      </div>
                      <div className="bg-white px-4 py-3">
                        <div className="text-xs text-slate-400">当前职位</div>
                        <div className="mt-1 text-sm font-semibold">
                          {detailOrder.required_position_name || "业务负责人"}
                        </div>
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="flex flex-wrap gap-2">
                        {detailOrder.workbook_id &&
                          detailOrder.workbook_sheet_id && (
                            <button
                              type="button"
                              onClick={() =>
                                rememberAndNavigate(
                                  `/sheets/${detailOrder.workbook_id}/${detailOrder.workbook_sheet_id}`,
                                )
                              }
                              className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-600"
                            >
                              <FileSpreadsheet className="h-4 w-4" />
                              打开流程工作簿
                            </button>
                          )}
                        {detailOrder.access?.can_sync_workbook && (
                          <button
                            type="button"
                            onClick={() => void syncWorkbook()}
                            disabled={syncingWorkbook}
                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-emerald-200 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
                          >
                            {syncingWorkbook ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RotateCcw className="h-4 w-4" />
                            )}
                            校准工作簿
                          </button>
                        )}
                        {detailOrder.channel_id && (
                          <button
                            type="button"
                            onClick={() => openChannel(detailOrder.channel_id)}
                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-sky-200 px-3 text-sm font-semibold text-sky-700 hover:bg-sky-50"
                          >
                            <MessageSquare className="h-4 w-4" />
                            客户频道
                          </button>
                        )}
                        {detailOrder.access?.can_view_customer_pricing && (
                          <button
                            type="button"
                            onClick={openPIModal}
                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-indigo-200 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
                          >
                            <FileText className="h-4 w-4" />
                            生成 PI
                          </button>
                        )}
                        {detailOrder.access?.can_view_packing && (
                          <button
                            type="button"
                            onClick={() =>
                              rememberAndNavigate(
                                `/trade/labels/${detailOrder.id}`,
                              )
                            }
                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-orange-200 px-3 text-sm font-semibold text-orange-700 hover:bg-orange-50"
                          >
                            <Printer className="h-4 w-4" />
                            SKU 标签
                          </button>
                        )}
                        {detailOrder.access?.can_view_profit && (
                          <button
                            type="button"
                            onClick={openProfitSettings}
                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-violet-200 px-3 text-sm font-semibold text-violet-700 hover:bg-violet-50"
                          >
                            <CircleDollarSign className="h-4 w-4" />
                            成本与汇率
                          </button>
                        )}
                        {tradeAccess?.is_admin && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(detailOrder)}
                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                          >
                            <Trash2 className="h-4 w-4" />
                            删除订单
                          </button>
                        )}
                      </div>
                      {detailOrder.access?.can_view_profit &&
                        detailOrder.profit_summary && (
                          <section className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-slate-50/60">
                            <div className="flex flex-col gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="text-sm font-semibold">
                                    订单利润汇总
                                  </h3>
                                  <span
                                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${detailOrder.profit_summary.finalized ? "bg-emerald-50 text-emerald-700" : detailOrder.profit_summary.cost_complete ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-700"}`}
                                  >
                                    {detailOrder.profit_summary.finalized
                                      ? "最终利润"
                                      : detailOrder.profit_summary.cost_complete
                                        ? "实时暂估"
                                        : "成本待补"}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-xs text-slate-400">
                                  商品利润与运费利润分开核算，并按本轮报价汇率折合人民币。
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={openProfitSettings}
                                className="h-8 self-start rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 sm:self-auto"
                              >
                                编辑成本
                              </button>
                            </div>
                            <div className="grid gap-px bg-slate-200 sm:grid-cols-3 xl:grid-cols-5">
                              {[
                                [
                                  "商品收入",
                                  detailOrder.profit_summary.goods_revenue,
                                ],
                                [
                                  "报价运费",
                                  detailOrder.profit_summary.freight_revenue,
                                ],
                                [
                                  "产品成本",
                                  detailOrder.profit_summary.product_cost,
                                ],
                                [
                                  "实际运费",
                                  detailOrder.profit_summary
                                    .actual_freight_cost,
                                ],
                                [
                                  "运费利润",
                                  detailOrder.profit_summary.freight_profit,
                                ],
                                [
                                  "附加成本",
                                  detailOrder.profit_summary.additional_cost,
                                ],
                                [
                                  "订单总利润",
                                  detailOrder.profit_summary.profit_amount,
                                ],
                              ].map(([label, value]) => (
                                <div
                                  key={String(label)}
                                  className="bg-white px-4 py-3"
                                >
                                  <div className="text-xs text-slate-400">
                                    {label}
                                  </div>
                                  <div
                                    className={`mt-1 text-sm font-semibold tabular-nums ${(label === "订单总利润" || label === "运费利润") && Number(value) < 0 ? "text-rose-700" : label === "订单总利润" || label === "运费利润" ? "text-emerald-700" : "text-slate-900"}`}
                                  >
                                    {formatFinancialMoney(
                                      detailOrder.profit_summary?.currency ||
                                        detailOrder.currency,
                                      Number(value),
                                    )}
                                  </div>
                                </div>
                              ))}
                              <div className="bg-white px-4 py-3">
                                <div className="text-xs text-slate-400">
                                  利润率
                                </div>
                                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                                  {formatPercent(
                                    detailOrder.profit_summary.profit_margin,
                                  )}
                                </div>
                              </div>
                              <div className="bg-white px-4 py-3">
                                <div className="text-xs text-slate-400">
                                  报价兑人民币
                                </div>
                                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                                  {detailOrder.profit_summary
                                    .exchange_rate_cny > 0
                                    ? `1 ${detailOrder.currency} = ${detailOrder.profit_summary.exchange_rate_cny} CNY`
                                    : "汇率待补"}
                                </div>
                              </div>
                              <div className="bg-white px-4 py-3">
                                <div className="text-xs text-slate-400">
                                  人民币总利润
                                </div>
                                <div
                                  className={`mt-1 text-sm font-semibold tabular-nums ${detailOrder.profit_summary.profit_amount_cny < 0 ? "text-rose-700" : "text-emerald-700"}`}
                                >
                                  {detailOrder.profit_summary.cny_complete
                                    ? formatFinancialMoney(
                                        "CNY",
                                        detailOrder.profit_summary
                                          .profit_amount_cny,
                                      )
                                    : "汇率待补"}
                                </div>
                              </div>
                            </div>
                            {(detailOrder.profit_summary.warnings.length > 0 ||
                              detailOrder.profit_summary
                                .additional_cost_notes) && (
                              <div className="space-y-1.5 border-t border-slate-200 px-4 py-3 text-xs">
                                {detailOrder.profit_summary.warnings.map(
                                  (warning) => (
                                    <div
                                      key={warning}
                                      className="text-amber-700"
                                    >
                                      {warning}
                                    </div>
                                  ),
                                )}
                                {detailOrder.profit_summary
                                  .additional_cost_notes && (
                                  <div className="text-slate-500">
                                    附加成本说明：
                                    {
                                      detailOrder.profit_summary
                                        .additional_cost_notes
                                    }
                                  </div>
                                )}
                              </div>
                            )}
                          </section>
                        )}
                      <div className="mt-6 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold">
                            产品与流程数据
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-400">
                            新增产品后会自动进入当前业务单的全部后续流程工作表。
                          </p>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          {detailOrder.can_operate_stage &&
                            (detailOrder.stage === "shipment" ||
                              (STAGE_DATA_FIELDS[detailOrder.stage] || [])
                                .length > 0) && (
                              <button
                                type="button"
                                onClick={openStageDataModal}
                                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-sky-200 px-3 text-xs font-semibold text-sky-700 hover:bg-sky-50"
                              >
                                <SlidersHorizontal className="h-3.5 w-3.5" />
                                编辑当前环节数据
                              </button>
                            )}
                          {detailOrder.access?.can_add_items && (
                            <button
                              type="button"
                              onClick={openAddItems}
                              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-200 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              添加产品
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full min-w-[980px] text-sm">
                          <thead className="bg-slate-50 text-left text-xs text-slate-500">
                            <tr>
                              <th className="px-3 py-2">序号</th>
                              <th className="px-3 py-2">SKU / 产品</th>
                              <th className="px-3 py-2">规格</th>
                              <th className="px-3 py-2 text-right">询价数量</th>
                              <th className="px-3 py-2">当前环节状态</th>
                              {detailOrder.access
                                ?.can_view_customer_pricing && (
                                <th className="px-3 py-2 text-right">
                                  当前对客报价
                                </th>
                              )}
                              {detailOrder.access?.can_view_supplier && (
                                <th className="px-3 py-2">采用供应商</th>
                              )}
                              {detailOrder.access
                                ?.can_view_supplier_pricing && (
                                <th className="px-3 py-2 text-right">采购价</th>
                              )}
                              {detailOrder.access?.can_view_receiving && (
                                <th className="px-3 py-2 text-right">到货</th>
                              )}
                              {detailOrder.access?.can_view_inspection && (
                                <th className="px-3 py-2 text-right">合格</th>
                              )}
                              {detailOrder.access?.can_view_packing && (
                                <th className="px-3 py-2 text-right">装箱</th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {(detailOrder.items || []).map((item) => (
                              <tr
                                key={item.id}
                                className="border-t border-slate-100"
                              >
                                <td className="px-3 py-2">{item.line_no}</td>
                                <td className="px-3 py-2">
                                  <div className="font-medium">
                                    {item.sku || "-"}
                                  </div>
                                  <div className="text-xs text-slate-400">
                                    {item.product_name}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-slate-500">
                                  {item.specification || "-"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {item.quantity} {item.unit}
                                </td>
                                <td className="px-3 py-2">
                                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                                    {stageItemStatus(detailOrder.stage, item)}
                                  </span>
                                </td>
                                {detailOrder.access
                                  ?.can_view_customer_pricing && (
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {formatMoney(
                                      detailOrder.currency,
                                      item.quoted_price,
                                    )}
                                  </td>
                                )}
                                {detailOrder.access?.can_view_supplier && (
                                  <td className="px-3 py-2">
                                    {item.supplier_name || "-"}
                                  </td>
                                )}
                                {detailOrder.access
                                  ?.can_view_supplier_pricing && (
                                  <td className="px-3 py-2 text-right">
                                    {formatMoney(
                                      item.purchase_currency ||
                                        detailOrder.currency,
                                      item.purchase_price,
                                    )}
                                  </td>
                                )}
                                {detailOrder.access?.can_view_receiving && (
                                  <td className="px-3 py-2 text-right">
                                    {item.received_quantity || 0}
                                  </td>
                                )}
                                {detailOrder.access?.can_view_inspection && (
                                  <td className="px-3 py-2 text-right">
                                    {item.accepted_quantity || 0}
                                  </td>
                                )}
                                {detailOrder.access?.can_view_packing && (
                                  <td className="px-3 py-2 text-right">
                                    {item.packed_quantity || 0}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {detailOrder.access?.can_view_customer_pricing && (
                        <section className="mt-6">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-semibold">
                                对客报价与议价
                              </h3>
                              <p className="mt-0.5 text-xs text-slate-400">
                                每次报价保留独立版本；客户砍价后记录反馈，再创建下一轮报价。
                              </p>
                            </div>
                            {detailOrder.can_operate_stage &&
                              detailOrder.stage === "quotation" && (
                                <button
                                  type="button"
                                  onClick={() => openCustomerQuoteModal()}
                                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-sky-700 px-3 text-xs font-semibold text-white hover:bg-sky-800"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  新建报价轮次
                                </button>
                              )}
                          </div>
                          {(detailOrder.customer_quotes || []).length === 0 ? (
                            <div className="mt-2 rounded-lg border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
                              尚未创建对客报价。进入本环节后，请先生成第一轮报价。
                            </div>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {(detailOrder.customer_quotes || []).map(
                                (quote) => (
                                  <article
                                    key={quote.id}
                                    className={`rounded-lg border p-3 ${quote.status === "accepted" ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`}
                                  >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                      <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="text-sm font-semibold text-slate-900">
                                            第 {quote.round_no} 轮报价
                                          </span>
                                          <span
                                            className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${customerQuoteStatusStyles[quote.status]}`}
                                          >
                                            {
                                              customerQuoteStatusLabels[
                                                quote.status
                                              ]
                                            }
                                          </span>
                                          <span className="text-xs font-semibold text-sky-700">
                                            {formatFinancialMoney(
                                              quote.currency,
                                              quote.total_amount,
                                            )}
                                          </span>
                                          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                            {quote.freight_mode === "quoted"
                                              ? "含我方运费"
                                              : "客户自有货代"}
                                          </span>
                                        </div>
                                        <div className="mt-1 text-xs text-slate-400">
                                          {quote.created_by_name || "系统"} ·{" "}
                                          {new Date(
                                            quote.sent_at || quote.created_at,
                                          ).toLocaleString("zh-CN")}
                                        </div>
                                      </div>
                                      {detailOrder.can_operate_stage &&
                                        detailOrder.stage === "quotation" && (
                                          <div className="flex flex-wrap gap-1.5">
                                            {(quote.status === "draft" ||
                                              quote.status === "sent") && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openCustomerQuoteModal(quote)
                                                }
                                                className="h-7 rounded-md border border-slate-200 px-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                                              >
                                                调整报价
                                              </button>
                                            )}
                                            {quote.status === "draft" && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openCustomerQuoteStatus(
                                                    quote,
                                                    "sent",
                                                  )
                                                }
                                                className="h-7 rounded-md border border-sky-200 px-2 text-xs font-semibold text-sky-700 hover:bg-sky-50"
                                              >
                                                标记已发送
                                              </button>
                                            )}
                                            {quote.status === "sent" && (
                                              <>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    openCustomerQuoteStatus(
                                                      quote,
                                                      "negotiating",
                                                    )
                                                  }
                                                  className="h-7 rounded-md border border-amber-200 px-2 text-xs font-semibold text-amber-700 hover:bg-amber-50"
                                                >
                                                  客户砍价
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    openCustomerQuoteStatus(
                                                      quote,
                                                      "accepted",
                                                    )
                                                  }
                                                  className="h-7 rounded-md border border-emerald-200 px-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                >
                                                  客户接受
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    openCustomerQuoteStatus(
                                                      quote,
                                                      "rejected",
                                                    )
                                                  }
                                                  className="h-7 rounded-md border border-rose-200 px-2 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                                >
                                                  客户拒绝
                                                </button>
                                              </>
                                            )}
                                            {(quote.status === "negotiating" ||
                                              quote.status === "rejected") && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  openCustomerQuoteModal(quote)
                                                }
                                                className="h-7 rounded-md bg-sky-700 px-2.5 text-xs font-semibold text-white hover:bg-sky-800"
                                              >
                                                基于本轮重新报价
                                              </button>
                                            )}
                                          </div>
                                        )}
                                    </div>
                                    <div className="mt-3 grid overflow-hidden rounded-lg border border-slate-100 bg-slate-100 sm:grid-cols-4">
                                      <div className="bg-white px-3 py-2">
                                        <div className="text-[10px] text-slate-400">
                                          商品金额
                                        </div>
                                        <div className="mt-0.5 text-xs font-semibold text-slate-700">
                                          {formatFinancialMoney(
                                            quote.currency,
                                            quote.goods_amount,
                                          )}
                                        </div>
                                      </div>
                                      <div className="bg-white px-3 py-2">
                                        <div className="text-[10px] text-slate-400">
                                          报价运费
                                        </div>
                                        <div className="mt-0.5 text-xs font-semibold text-slate-700">
                                          {quote.freight_mode === "quoted"
                                            ? formatFinancialMoney(
                                                quote.currency,
                                                quote.freight_amount,
                                              )
                                            : "不报价"}
                                        </div>
                                      </div>
                                      <div className="bg-white px-3 py-2">
                                        <div className="text-[10px] text-slate-400">
                                          报价合计
                                        </div>
                                        <div className="mt-0.5 text-xs font-semibold text-sky-700">
                                          {formatFinancialMoney(
                                            quote.currency,
                                            quote.total_amount,
                                          )}
                                        </div>
                                      </div>
                                      <div className="bg-white px-3 py-2">
                                        <div className="text-[10px] text-slate-400">
                                          折合人民币
                                        </div>
                                        <div className="mt-0.5 text-xs font-semibold text-rose-700">
                                          {quote.total_amount_cny > 0
                                            ? formatFinancialMoney(
                                                "CNY",
                                                quote.total_amount_cny,
                                              )
                                            : "汇率待补"}
                                        </div>
                                        <div className="mt-0.5 text-[10px] text-slate-400">
                                          1 {quote.currency} ={" "}
                                          {quote.exchange_rate_cny || "-"} CNY
                                        </div>
                                      </div>
                                    </div>
                                    <div className="mt-3 overflow-x-auto rounded-lg border border-slate-100">
                                      <table className="w-full min-w-[620px] text-xs">
                                        <thead className="bg-slate-50 text-left text-slate-400">
                                          <tr>
                                            <th className="px-3 py-2">产品</th>
                                            <th className="px-3 py-2 text-right">
                                              数量
                                            </th>
                                            <th className="px-3 py-2 text-right">
                                              对客单价
                                            </th>
                                            <th className="px-3 py-2 text-right">
                                              金额
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {quote.items.map((item) => (
                                            <tr
                                              key={item.order_item_id}
                                              className="border-t border-slate-100"
                                            >
                                              <td className="px-3 py-2">
                                                <span className="font-medium text-slate-700">
                                                  {item.sku ||
                                                    item.product_name}
                                                </span>
                                                <span className="ml-1 text-slate-400">
                                                  {item.product_name}
                                                </span>
                                              </td>
                                              <td className="px-3 py-2 text-right">
                                                {item.quantity} {item.unit}
                                              </td>
                                              <td className="px-3 py-2 text-right">
                                                {formatMoney(
                                                  quote.currency,
                                                  item.unit_price,
                                                )}
                                              </td>
                                              <td className="px-3 py-2 text-right font-medium">
                                                {formatMoney(
                                                  quote.currency,
                                                  item.amount,
                                                )}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                    {(quote.customer_feedback ||
                                      quote.notes) && (
                                      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                                        {quote.customer_feedback && (
                                          <div className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
                                            <span className="font-semibold">
                                              客户反馈：
                                            </span>
                                            {quote.customer_feedback}
                                          </div>
                                        )}
                                        {quote.notes && (
                                          <div className="rounded-md bg-slate-50 px-3 py-2 text-slate-600">
                                            <span className="font-semibold">
                                              内部备注：
                                            </span>
                                            {quote.notes}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </article>
                                ),
                              )}
                            </div>
                          )}
                        </section>
                      )}
                      {detailOrder.access?.can_view_supplier && (
                        <>
                          <div className="mt-6 flex items-center justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-semibold">
                                供应商比价
                              </h3>
                              <p className="mt-0.5 text-xs text-slate-400">
                                可为同一 SKU
                                录入多个供应商报价，再选择采购方案。
                              </p>
                            </div>
                            {detailOrder.can_operate_stage &&
                              detailOrder.stage === "supplier_quote" && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setQuoteDraft(
                                      newSupplierQuoteDraft(
                                        detailOrder,
                                        suppliers,
                                      ),
                                    );
                                    setQuoteModalOpen(true);
                                  }}
                                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-pink-700 px-3 text-xs font-semibold text-white"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  录入报价
                                </button>
                              )}
                          </div>
                          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
                            <table className="w-full min-w-[850px] text-sm">
                              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                                <tr>
                                  <th className="px-3 py-2">产品</th>
                                  <th className="px-3 py-2">供应商</th>
                                  <th className="px-3 py-2 text-right">单价</th>
                                  <th className="px-3 py-2 text-right">MOQ</th>
                                  <th className="px-3 py-2 text-right">交期</th>
                                  <th className="px-3 py-2">有效期</th>
                                  <th className="px-3 py-2">备注</th>
                                  <th className="px-3 py-2 text-right">采用</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(detailOrder.supplier_quotes || []).length ===
                                0 ? (
                                  <tr>
                                    <td
                                      colSpan={8}
                                      className="h-24 text-center text-slate-400"
                                    >
                                      尚未录入供应商报价
                                    </td>
                                  </tr>
                                ) : (
                                  (detailOrder.supplier_quotes || []).map(
                                    (quote) => (
                                      <tr
                                        key={quote.id}
                                        className={`border-t border-slate-100 ${quote.is_selected ? "bg-emerald-50/70" : ""}`}
                                      >
                                        <td className="px-3 py-2">
                                          <div className="font-medium">
                                            {quote.sku ||
                                              `第 ${quote.line_no} 行`}
                                          </div>
                                          <div className="text-xs text-slate-400">
                                            {quote.product_name}
                                          </div>
                                        </td>
                                        <td className="px-3 py-2">
                                          <div className="font-medium">
                                            {quote.supplier_name}
                                          </div>
                                          <div className="text-xs text-slate-400">
                                            {quote.supplier_code}
                                          </div>
                                        </td>
                                        <td className="px-3 py-2 text-right font-medium">
                                          {formatMoney(
                                            quote.currency,
                                            quote.unit_price,
                                          )}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          {quote.moq || "-"}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          {quote.lead_time_days
                                            ? `${quote.lead_time_days} 天`
                                            : "-"}
                                        </td>
                                        <td className="px-3 py-2">
                                          {formatDate(quote.valid_until)}
                                        </td>
                                        <td className="max-w-48 truncate px-3 py-2 text-slate-500">
                                          {quote.notes || "-"}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          {quote.is_selected ? (
                                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                                              <Check className="h-3.5 w-3.5" />
                                              已采用
                                            </span>
                                          ) : detailOrder.can_operate_stage &&
                                            detailOrder.stage ===
                                              "supplier_quote" ? (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void selectSupplierQuote(
                                                  quote.id,
                                                )
                                              }
                                              className="h-7 rounded-md border border-slate-200 px-2 text-xs font-semibold hover:bg-slate-50"
                                            >
                                              采用
                                            </button>
                                          ) : (
                                            <span className="text-xs text-slate-400">
                                              待负责岗位处理
                                            </span>
                                          )}
                                        </td>
                                      </tr>
                                    ),
                                  )
                                )}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                      {detailOrder.access?.can_view_inspection && (
                        <div className="mt-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="text-sm font-semibold">
                                质检照片
                              </h3>
                              <p className="mt-0.5 text-xs text-slate-400">
                                图片会关联订单和
                                SKU，并自动保存到公共质检图库目录。
                              </p>
                            </div>
                            <Images className="h-5 w-5 text-teal-600" />
                          </div>
                          {detailOrder.can_operate_stage &&
                            detailOrder.stage === "inspection" && (
                              <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[180px_1fr_auto]">
                                <select
                                  value={inspectionItemID}
                                  onChange={(event) =>
                                    setInspectionItemID(
                                      event.target.value
                                        ? Number(event.target.value)
                                        : "",
                                    )
                                  }
                                  className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"
                                >
                                  <option value="">整单质检</option>
                                  {(detailOrder.items || []).map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.line_no}.{" "}
                                      {item.sku || item.product_name}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  value={inspectionNote}
                                  onChange={(event) =>
                                    setInspectionNote(event.target.value)
                                  }
                                  className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm"
                                  placeholder="质检说明、问题或处理意见"
                                />
                                <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-teal-200 bg-white px-3 text-sm font-semibold text-teal-700">
                                  <ImagePlus className="h-4 w-4" />
                                  选择图片
                                  <input
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={(event) =>
                                      setInspectionFiles(
                                        Array.from(event.target.files || []),
                                      )
                                    }
                                  />
                                </label>
                                {inspectionFiles.length > 0 && (
                                  <div className="text-xs text-slate-500 sm:col-span-2">
                                    已选择 {inspectionFiles.length} 张：
                                    {inspectionFiles
                                      .map((file) => file.name)
                                      .join("、")}
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void uploadInspectionPhotos()}
                                  disabled={
                                    uploadingInspection ||
                                    inspectionFiles.length === 0
                                  }
                                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white disabled:opacity-40 sm:col-start-3"
                                >
                                  {uploadingInspection ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <ImagePlus className="h-4 w-4" />
                                  )}
                                  上传
                                </button>
                              </div>
                            )}
                          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                            {(detailOrder.inspection_photos || []).map(
                              (photo) => (
                                <button
                                  key={photo.id}
                                  type="button"
                                  onClick={() => setSelectedPhoto(photo)}
                                  className="overflow-hidden rounded-lg border border-slate-200 bg-white text-left hover:border-teal-300"
                                >
                                  <div className="aspect-[4/3] bg-slate-100">
                                    <img
                                      src={
                                        photo.thumbnail_url ||
                                        photo.attachment_url
                                      }
                                      alt={photo.filename}
                                      className="h-full w-full object-cover"
                                    />
                                  </div>
                                  <div className="p-2">
                                    <div className="truncate text-xs font-semibold">
                                      {photo.sku || "整单质检"}
                                    </div>
                                    <div className="mt-0.5 truncate text-[11px] text-slate-400">
                                      {photo.note || photo.filename}
                                    </div>
                                  </div>
                                </button>
                              ),
                            )}
                            {(detailOrder.inspection_photos || []).length ===
                              0 && (
                              <div className="col-span-full rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
                                暂无质检照片
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="mt-6 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold">
                            {detailOrder.access?.can_view_timeline
                              ? "流程时间线"
                              : "当前任务记录"}
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-400">
                            共 {detailOrder.events?.length || 0} 条流程记录
                          </p>
                        </div>
                        {(detailOrder.events?.length || 0) > 4 && (
                          <button
                            type="button"
                            onClick={() =>
                              setTimelineExpanded((current) => !current)
                            }
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            {timelineExpanded ? (
                              <ChevronUp className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                            {timelineExpanded ? "收起" : "展开全部"}
                          </button>
                        )}
                      </div>
                      <div className="mt-3 space-y-0">
                        {visibleTimelineEvents.map((event, index) => {
                          const stage = stageDefinition(event.to_stage);
                          const Icon = stage?.icon || Check;
                          const returned =
                            event.from_stage &&
                            STAGES.findIndex(
                              (item) => item.key === event.to_stage,
                            ) <
                              STAGES.findIndex(
                                (item) => item.key === event.from_stage,
                              );
                          return (
                            <div
                              key={event.id}
                              className="relative flex gap-3 pb-5"
                            >
                              <div
                                className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${stage?.background || "bg-slate-100"} ${stage?.color || "text-slate-600"}`}
                              >
                                {returned ? (
                                  <ChevronLeft className="h-4 w-4" />
                                ) : (
                                  <Icon className="h-4 w-4" />
                                )}
                              </div>
                              {index < visibleTimelineEvents.length - 1 && (
                                <div className="absolute bottom-0 left-[15px] top-8 w-px bg-slate-200" />
                              )}
                              <div className="min-w-0 flex-1 pt-0.5">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-sm font-semibold">
                                    {returned ? "退回" : "进入"}
                                    {stage?.label || event.to_stage}阶段
                                  </span>
                                  <span className="shrink-0 text-[11px] text-slate-400">
                                    {new Date(event.created_at).toLocaleString(
                                      "zh-CN",
                                    )}
                                  </span>
                                </div>
                                <p className="mt-1 text-xs leading-5 text-slate-500">
                                  {event.note} · {event.actor_name || "系统"}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {detailOrder.can_operate_stage &&
                        (detailOrder.can_return ||
                          nextStage(detailOrder.stage)) && (
                          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold">
                                  流程交接
                                </div>
                                <p className="mt-0.5 text-xs text-slate-400">
                                  当前由“
                                  {detailOrder.required_position_name ||
                                    "业务负责人"}
                                  ”处理；系统会先校验本环节资料，交接后记录时间线并通知目标职位。
                                </p>
                              </div>
                              <BellRing className="h-5 w-5 text-slate-500" />
                            </div>
                            {(detailOrder.advance_blockers || []).length >
                              0 && (
                              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                                <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                                  <ClipboardCheck className="h-4 w-4" />
                                  推进前还需完成
                                </div>
                                <ul className="mt-1.5 space-y-1 text-xs leading-5 text-amber-700">
                                  {(detailOrder.advance_blockers || []).map(
                                    (blocker) => (
                                      <li key={blocker}>· {blocker}</li>
                                    ),
                                  )}
                                </ul>
                              </div>
                            )}
                            <textarea
                              value={advanceNote}
                              onChange={(event) =>
                                setAdvanceNote(event.target.value)
                              }
                              className="mt-3 min-h-20 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none"
                              placeholder="填写交接说明、退回原因或下一环节注意事项（可选）"
                            />
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                              <div>
                                {detailOrder.can_return &&
                                  previousStage(detailOrder.stage) && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void flowOrder(
                                          previousStage(detailOrder.stage)!,
                                        )
                                      }
                                      disabled={flowing}
                                      className="inline-flex h-9 items-center gap-2 rounded-lg border border-amber-200 bg-white px-4 text-sm font-semibold text-amber-700 disabled:opacity-40"
                                    >
                                      {flowing ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                      ) : (
                                        <ArrowLeft className="h-4 w-4" />
                                      )}
                                      退回
                                      {
                                        stageDefinition(
                                          previousStage(detailOrder.stage)!,
                                        )?.label
                                      }
                                    </button>
                                  )}
                              </div>
                              {nextStage(detailOrder.stage) && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void flowOrder(
                                      nextStage(detailOrder.stage)!,
                                    )
                                  }
                                  disabled={
                                    flowing ||
                                    (detailOrder.advance_blockers || [])
                                      .length > 0
                                  }
                                  title={
                                    (detailOrder.advance_blockers || [])
                                      .length > 0
                                      ? "请先完成本环节必填资料"
                                      : "推进到下一业务环节"
                                  }
                                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                                >
                                  {flowing ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <ArrowRight className="h-4 w-4" />
                                  )}
                                  推进到
                                  {
                                    stageDefinition(
                                      nextStage(detailOrder.stage)!,
                                    )?.label
                                  }
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                    </div>
                  </>
                )}
              </div>
            </aside>
          </div>
        )}

        {piModalOpen && detailOrder && piDraft && selectedPIQuote && (
          <div
            className="fixed inset-0 z-[92] flex items-end justify-center bg-slate-950/55 p-0 lg:items-center lg:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !piAction)
                closePIModal();
            }}
          >
            <div className="flex max-h-[96vh] w-full max-w-7xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl lg:rounded-lg">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Proforma Invoice
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {detailOrder.order_no} · {detailOrder.customer_name} · 第{" "}
                    {selectedPIQuote.round_no} 轮报价
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closePIModal}
                  disabled={Boolean(piAction)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[390px_minmax(0,1fr)] lg:overflow-hidden">
                <div className="space-y-4 border-b border-slate-200 p-4 lg:overflow-y-auto lg:border-b-0 lg:border-r sm:p-5">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      报价轮次
                    </span>
                    <select
                      value={piDraft.quote_id}
                      onChange={(event) =>
                        updatePIDraft({ quote_id: Number(event.target.value) })
                      }
                      className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    >
                      {(detailOrder.customer_quotes || [])
                        .filter(
                          (quote) =>
                            quote.status !== "draft" &&
                            quote.status !== "rejected",
                        )
                        .map((quote) => (
                          <option key={quote.id} value={quote.id}>
                            第 {quote.round_no} 轮 ·{" "}
                            {customerQuoteStatusLabels[quote.status]} ·{" "}
                            {formatFinancialMoney(
                              quote.currency,
                              quote.total_amount,
                            )}
                          </option>
                        ))}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        开具日期
                      </span>
                      <input
                        type="date"
                        value={piDraft.issue_date}
                        onChange={(event) =>
                          updatePIDraft({ issue_date: event.target.value })
                        }
                        className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        有效期至
                      </span>
                      <input
                        type="date"
                        value={piDraft.valid_until}
                        onChange={(event) =>
                          updatePIDraft({ valid_until: event.target.value })
                        }
                        className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      付款方式
                    </span>
                    <input
                      list="trade-pi-payment-methods"
                      value={piDraft.payment_method}
                      onChange={(event) =>
                        updatePIDraft({ payment_method: event.target.value })
                      }
                      className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                    <datalist id="trade-pi-payment-methods">
                      {settings.payment_methods.map((method) => (
                        <option key={method} value={method} />
                      ))}
                    </datalist>
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      交付条款
                    </span>
                    <input
                      value={piDraft.delivery_terms}
                      onChange={(event) =>
                        updatePIDraft({ delivery_terms: event.target.value })
                      }
                      placeholder="例如 FOB Shanghai / DDP Milan"
                      className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      交货时间
                    </span>
                    <input
                      value={piDraft.delivery_time}
                      onChange={(event) =>
                        updatePIDraft({ delivery_time: event.target.value })
                      }
                      placeholder="例如 15 days after deposit"
                      className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      本次 PI 备注
                    </span>
                    <textarea
                      value={piDraft.notes}
                      onChange={(event) =>
                        updatePIDraft({ notes: event.target.value })
                      }
                      placeholder="Warranty, packing, shipment or other terms"
                      className="min-h-24 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                  </label>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-slate-700">
                          {settings.pi_profile.company_name}
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-slate-400">
                          {settings.pi_profile.bank_name || "尚未配置收款银行"}{" "}
                          ·{" "}
                          {settings.pi_profile.account_number ||
                            "尚未配置收款账号"}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          closePIModal();
                          setSettingsTab("pi");
                          setSettingsOpen(true);
                        }}
                        className="shrink-0 text-xs font-semibold text-indigo-700"
                      >
                        编辑抬头
                      </button>
                    </div>
                  </div>
                </div>

                <div className="min-h-[520px] bg-slate-100 p-3 sm:p-5 lg:overflow-auto">
                  {piPreviewURL ? (
                    <iframe
                      src={piPreviewURL}
                      title="PI PDF 预览"
                      className="mx-auto h-[760px] w-full max-w-[760px] border border-slate-200 bg-white shadow-sm"
                    />
                  ) : (
                    <div className="mx-auto min-h-[760px] w-full max-w-[760px] bg-white p-7 shadow-sm sm:p-10">
                      <div className="flex items-start justify-between gap-6 border-b-4 border-slate-900 pb-5">
                        <div>
                          <div className="text-lg font-black text-slate-900">
                            {settings.pi_profile.company_name}
                          </div>
                          <div className="mt-2 max-w-sm whitespace-pre-line text-xs leading-5 text-slate-500">
                            {[
                              settings.pi_profile.address,
                              settings.pi_profile.phone,
                              settings.pi_profile.email,
                            ]
                              .filter(Boolean)
                              .join("\n")}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-black tracking-wide text-slate-900">
                            PROFORMA
                            <br />
                            INVOICE
                          </div>
                          <div className="mt-2 text-xs font-semibold text-slate-500">
                            PI-{detailOrder.order_no}-R
                            {selectedPIQuote.round_no}
                          </div>
                        </div>
                      </div>
                      <div className="mt-5 grid grid-cols-2 border border-slate-200 text-xs">
                        <div className="p-4">
                          <div className="text-[10px] font-semibold uppercase text-slate-400">
                            Seller
                          </div>
                          <div className="mt-1.5 font-bold">
                            {settings.pi_profile.company_name}
                          </div>
                        </div>
                        <div className="border-l border-slate-200 p-4">
                          <div className="text-[10px] font-semibold uppercase text-slate-400">
                            Bill To
                          </div>
                          <div className="mt-1.5 font-bold">
                            {detailOrder.customer_company ||
                              detailOrder.customer_name}
                          </div>
                          <div className="mt-1 text-slate-500">
                            {detailOrder.customer_name}
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-4 border border-slate-200 text-xs">
                        {[
                          ["Issue Date", piDraft.issue_date],
                          ["Valid Until", piDraft.valid_until],
                          ["Order", detailOrder.order_no],
                          ["Currency", selectedPIQuote.currency],
                        ].map(([label, value], index) => (
                          <div
                            key={label}
                            className={`p-3 ${index > 0 ? "border-l border-slate-200" : ""}`}
                          >
                            <div className="text-[9px] font-semibold uppercase text-slate-400">
                              {label}
                            </div>
                            <div className="mt-1 font-semibold">{value}</div>
                          </div>
                        ))}
                      </div>
                      <table className="mt-5 w-full border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-900 text-left text-white">
                            <th className="px-3 py-2">SKU</th>
                            <th className="px-3 py-2">Description</th>
                            <th className="px-3 py-2 text-right">Qty</th>
                            <th className="px-3 py-2 text-right">Unit Price</th>
                            <th className="px-3 py-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedPIQuote.items.map((item) => (
                            <tr key={item.order_item_id}>
                              <td className="border border-slate-200 px-3 py-2">
                                {item.sku}
                              </td>
                              <td className="border border-slate-200 px-3 py-2 font-semibold">
                                {item.product_name}
                              </td>
                              <td className="border border-slate-200 px-3 py-2 text-right">
                                {item.quantity} {item.unit}
                              </td>
                              <td className="border border-slate-200 px-3 py-2 text-right">
                                {item.unit_price.toFixed(2)}
                              </td>
                              <td className="border border-slate-200 px-3 py-2 text-right font-semibold">
                                {item.amount.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                          {selectedPIQuote.freight_mode === "quoted" && (
                            <tr>
                              <td
                                colSpan={4}
                                className="border border-slate-200 px-3 py-2"
                              >
                                Freight
                              </td>
                              <td className="border border-slate-200 px-3 py-2 text-right font-semibold">
                                {selectedPIQuote.freight_amount.toFixed(2)}
                              </td>
                            </tr>
                          )}
                          <tr className="bg-slate-100">
                            <td
                              colSpan={4}
                              className="border border-slate-200 px-3 py-3 font-bold"
                            >
                              TOTAL ({selectedPIQuote.currency})
                            </td>
                            <td className="border border-slate-200 px-3 py-3 text-right text-sm font-black">
                              {selectedPIQuote.total_amount.toFixed(2)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <div className="mt-6 grid gap-5 border-t border-slate-300 pt-5 text-xs sm:grid-cols-2">
                        <div>
                          <div className="font-bold uppercase text-slate-700">
                            Commercial Terms
                          </div>
                          <div className="mt-2 grid grid-cols-[90px_1fr] gap-1 leading-5">
                            <span className="text-slate-400">Payment</span>
                            <span>{piDraft.payment_method || "-"}</span>
                            <span className="text-slate-400">Delivery</span>
                            <span>{piDraft.delivery_terms || "-"}</span>
                            <span className="text-slate-400">Lead Time</span>
                            <span>{piDraft.delivery_time || "-"}</span>
                          </div>
                        </div>
                        <div>
                          <div className="font-bold uppercase text-slate-700">
                            Beneficiary Bank
                          </div>
                          <div className="mt-2 leading-5 text-slate-500">
                            {settings.pi_profile.bank_name || "Not configured"}
                            <br />
                            {settings.pi_profile.account_name}
                            <br />
                            {settings.pi_profile.account_number}
                            <br />
                            {settings.pi_profile.swift_code}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
                <div className="text-xs text-slate-400">
                  PDF 仅包含客户报价，不包含供应商、采购价或内部利润。
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void previewPI()}
                    disabled={Boolean(piAction)}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    {piAction === "preview" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    PDF 预览
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadPI()}
                    disabled={Boolean(piAction)}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-indigo-200 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
                  >
                    {piAction === "download" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    下载 PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendPI()}
                    disabled={Boolean(piAction) || !detailOrder.channel_id}
                    title={
                      detailOrder.channel_id
                        ? "发送到客户频道，并按频道联动设置发送到 WhatsApp"
                        : "该客户尚未关联频道"
                    }
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    {piAction === "send" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    发送客户
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {profitSettingsOpen && detailOrder && profitSettingsDraft && (
          <div
            className="fixed inset-0 z-[93] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !savingProfitSettings)
                setProfitSettingsOpen(false);
            }}
          >
            <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    成本与利润设置
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    跨币种采购请填写“1
                    单位采购币种折合多少订单币种”，保存后自动重算利润。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setProfitSettingsOpen(false)}
                  disabled={savingProfitSettings}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      附加成本（{detailOrder.currency}）
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={profitSettingsDraft.additional_cost_amount}
                      onChange={(event) =>
                        setProfitSettingsDraft((current) =>
                          current
                            ? {
                                ...current,
                                additional_cost_amount: event.target.value,
                              }
                            : current,
                        )
                      }
                      className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">
                      附加成本说明
                    </span>
                    <input
                      value={profitSettingsDraft.additional_cost_notes}
                      onChange={(event) =>
                        setProfitSettingsDraft((current) =>
                          current
                            ? {
                                ...current,
                                additional_cost_notes: event.target.value,
                              }
                            : current,
                        )
                      }
                      placeholder="运费、关税、包装、平台费等"
                      className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                    />
                  </label>
                </div>
                <section className="overflow-hidden rounded-lg border border-slate-200">
                  <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                    <h4 className="text-sm font-semibold">产品成本换算率</h4>
                    <p className="mt-0.5 text-xs text-slate-400">
                      同币种固定为 1；缺少跨币种换算率时，利润会标记为暂估。
                    </p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {(detailOrder.items || []).map((item) => {
                      const purchaseCurrency =
                        item.purchase_currency || detailOrder.currency;
                      const sameCurrency =
                        purchaseCurrency.toUpperCase() ===
                        detailOrder.currency.toUpperCase();
                      return (
                        <div
                          key={item.id}
                          className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-800">
                              {item.line_no}. {item.sku || item.product_name} ·{" "}
                              {item.product_name}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-400">
                              采购价{" "}
                              {formatFinancialMoney(
                                purchaseCurrency,
                                item.purchase_price,
                              )}{" "}
                              × {item.quantity} {item.unit}
                            </div>
                          </div>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-slate-500">
                              {purchaseCurrency} → {detailOrder.currency}
                            </span>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              disabled={sameCurrency}
                              value={
                                sameCurrency
                                  ? "1"
                                  : profitSettingsDraft.item_rates[item.id] ||
                                    ""
                              }
                              onChange={(event) =>
                                setProfitSettingsDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        item_rates: {
                                          ...current.item_rates,
                                          [item.id]: event.target.value,
                                        },
                                      }
                                    : current,
                                )
                              }
                              placeholder="例如 0.14"
                              className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 disabled:bg-slate-100 disabled:text-slate-500"
                            />
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 sm:px-5">
                <button
                  type="button"
                  onClick={() => setProfitSettingsOpen(false)}
                  disabled={savingProfitSettings}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveProfitSettings()}
                  disabled={savingProfitSettings}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingProfitSettings ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存并重算
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div
            className="fixed inset-0 z-[94] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deletingOrder)
                setDeleteTarget(null);
            }}
          >
            <div className="w-full max-w-md rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    删除业务订单
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    仅管理员可以执行此操作。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deletingOrder}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-4 text-sm leading-6 text-slate-600">
                <p>
                  将订单{" "}
                  <strong className="text-slate-900">
                    {deleteTarget.order_no} · {deleteTarget.title}
                  </strong>
                  移入回收站。
                </p>
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  产品、供应商报价、对客报价、流程记录和关联工作簿会一起保留 30
                  天。管理员可从回收站完整还原；客户档案、客户频道和图库资料不会删除。
                </p>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deletingOrder}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void deleteOrder()}
                  disabled={deletingOrder}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40"
                >
                  {deletingOrder ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  移入回收站
                </button>
              </div>
            </div>
          </div>
        )}

        {stageDataModalOpen && detailOrder && (
          <div
            className="fixed inset-0 z-[92] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !savingStageData)
                setStageDataModalOpen(false);
            }}
          >
            <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    编辑
                    {stageDefinition(detailOrder.stage)?.label || "当前环节"}
                    数据
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    在 ERP
                    或流程工作表中修改都会双向同步；身份字段和其他岗位数据保持只读。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setStageDataModalOpen(false)}
                  disabled={savingStageData}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {detailOrder.stage === "shipment" ? (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      ["booking_no", "订舱号", "text"],
                      ["carrier", "承运人", "text"],
                      ["vessel_flight", "船名 / 航班", "text"],
                      ["etd", "ETD", "date"],
                      ["eta", "ETA", "date"],
                      ["bl_no", "提单号", "text"],
                    ].map(([key, label, type]) => (
                      <label key={key} className="block">
                        <span className="mb-1.5 block text-xs font-medium text-slate-600">
                          {label}
                        </span>
                        <input
                          type={type}
                          value={
                            stageShipmentDraft[key as keyof StageShipmentDraft]
                          }
                          onChange={(event) =>
                            setStageShipmentDraft((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }))
                          }
                          className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                        />
                      </label>
                    ))}
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        运输状态
                      </span>
                      <select
                        value={stageShipmentDraft.shipping_status}
                        onChange={(event) =>
                          setStageShipmentDraft((current) => ({
                            ...current,
                            shipping_status: event.target.value,
                          }))
                        }
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      >
                        {SHIPMENT_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </label>
                    {detailOrder.freight_mode === "quoted" ? (
                      <section className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 sm:col-span-2 lg:col-span-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-sm font-semibold text-violet-900">
                              最终实际运费
                            </div>
                            <p className="mt-0.5 text-xs text-violet-700">
                              对客报价运费{" "}
                              {formatFinancialMoney(
                                detailOrder.currency,
                                detailOrder.quoted_freight_amount,
                              )}
                              ，录入实际费用后自动计算运费利润。
                            </p>
                          </div>
                          {detailOrder.profit_summary?.cny_complete && (
                            <span className="text-xs font-semibold text-violet-700">
                              当前运费利润{" "}
                              {formatFinancialMoney(
                                "CNY",
                                detailOrder.profit_summary.freight_profit_cny,
                              )}
                            </span>
                          )}
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-slate-600">
                              实际运费币种
                            </span>
                            <input
                              list="trade-currency-options"
                              value={stageShipmentDraft.actual_freight_currency}
                              onChange={(event) =>
                                setStageShipmentDraft((current) => ({
                                  ...current,
                                  actual_freight_currency:
                                    event.target.value.toUpperCase(),
                                  actual_freight_to_cny_rate:
                                    event.target.value.toUpperCase() === "CNY"
                                      ? "1"
                                      : current.actual_freight_currency ===
                                          "CNY"
                                        ? ""
                                        : current.actual_freight_to_cny_rate,
                                }))
                              }
                              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm uppercase outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-slate-600">
                              最终实际运费
                            </span>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={stageShipmentDraft.actual_freight_amount}
                              onChange={(event) =>
                                setStageShipmentDraft((current) => ({
                                  ...current,
                                  actual_freight_amount: event.target.value,
                                }))
                              }
                              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-slate-600">
                              实际运费兑人民币
                            </span>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              disabled={
                                stageShipmentDraft.actual_freight_currency ===
                                "CNY"
                              }
                              value={
                                stageShipmentDraft.actual_freight_currency ===
                                "CNY"
                                  ? "1"
                                  : stageShipmentDraft.actual_freight_to_cny_rate
                              }
                              onChange={(event) =>
                                setStageShipmentDraft((current) => ({
                                  ...current,
                                  actual_freight_to_cny_rate:
                                    event.target.value,
                                }))
                              }
                              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none disabled:bg-slate-100"
                            />
                          </label>
                        </div>
                        <label className="mt-3 block">
                          <span className="mb-1.5 block text-xs font-medium text-slate-600">
                            实际运费说明
                          </span>
                          <input
                            value={stageShipmentDraft.actual_freight_notes}
                            onChange={(event) =>
                              setStageShipmentDraft((current) => ({
                                ...current,
                                actual_freight_notes: event.target.value,
                              }))
                            }
                            placeholder="账单号、附加费、调整原因等"
                            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none"
                          />
                        </label>
                      </section>
                    ) : (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800 sm:col-span-2 lg:col-span-3">
                        客户使用自有货代，本订单不向客户报价运费，也不要求录入我方实际运费。
                      </div>
                    )}
                    <label className="block sm:col-span-2 lg:col-span-3">
                      <span className="mb-1.5 block text-xs font-medium text-slate-600">
                        发货备注
                      </span>
                      <textarea
                        value={stageShipmentDraft.notes}
                        onChange={(event) =>
                          setStageShipmentDraft((current) => ({
                            ...current,
                            notes: event.target.value,
                          }))
                        }
                        className="min-h-24 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      />
                    </label>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {(detailOrder.items || []).map((item) => (
                      <section
                        key={item.id}
                        className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 sm:p-4"
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-slate-900">
                              {item.line_no}. {item.sku || item.product_name}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-slate-400">
                              {item.product_name}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-slate-500">
                              {item.quantity} {item.unit}
                            </span>
                            {detailOrder.access?.can_add_items &&
                              ["inquiry", "supplier_quote", "quotation"].includes(
                                detailOrder.stage,
                              ) && (
                                <button
                                  type="button"
                                  onClick={() => setOrderItemDeleteTarget(item)}
                                  disabled={
                                    (detailOrder.items || []).length <= 1 ||
                                    savingStageData ||
                                    deletingOrderItem
                                  }
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
                                  title={
                                    (detailOrder.items || []).length <= 1
                                      ? "订单至少需要保留一个产品"
                                      : "从订单中删除这个产品"
                                  }
                                  aria-label={`删除产品 ${item.sku || item.product_name}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                          </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {(STAGE_DATA_FIELDS[detailOrder.stage] || []).map(
                            (field) => (
                              <label
                                key={field.key}
                                className={`block ${field.key === "description" || field.key === "inspection_issue" || field.key === "marks" ? "sm:col-span-2" : ""}`}
                              >
                                <span className="mb-1.5 block text-xs font-medium text-slate-600">
                                  {field.label}
                                </span>
                                {field.type === "select" ? (
                                  <select
                                    value={
                                      stageItemDrafts[item.id]?.[field.key] ||
                                      ""
                                    }
                                    onChange={(event) =>
                                      updateStageItemDraft(
                                        item.id,
                                        field.key,
                                        event.target.value,
                                      )
                                    }
                                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                                  >
                                    {(field.options || []).map((option) => (
                                      <option key={option} value={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type={field.type || "text"}
                                    min={
                                      field.type === "number" ? 0 : undefined
                                    }
                                    step={
                                      field.type === "number"
                                        ? "any"
                                        : undefined
                                    }
                                    value={
                                      stageItemDrafts[item.id]?.[field.key] ||
                                      ""
                                    }
                                    onChange={(event) =>
                                      updateStageItemDraft(
                                        item.id,
                                        field.key,
                                        event.target.value,
                                      )
                                    }
                                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                                  />
                                )}
                              </label>
                            ),
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
                <button
                  type="button"
                  onClick={() => setStageDataModalOpen(false)}
                  disabled={savingStageData}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveStageData()}
                  disabled={savingStageData}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {savingStageData ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存并同步
                </button>
              </div>
            </div>
          </div>
        )}

        {orderItemDeleteTarget && detailOrder && (
          <div
            className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deletingOrderItem)
                setOrderItemDeleteTarget(null);
            }}
          >
            <div className="w-full max-w-md overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="font-semibold">删除订单产品</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {detailOrder.order_no} · 第 {orderItemDeleteTarget.line_no} 行
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOrderItemDeleteTarget(null)}
                  disabled={deletingOrderItem}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 p-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="font-semibold text-slate-900">
                    {orderItemDeleteTarget.sku ||
                      orderItemDeleteTarget.product_name}
                  </div>
                  <div className="mt-1 text-sm text-slate-500">
                    {orderItemDeleteTarget.product_name} ·{" "}
                    {orderItemDeleteTarget.quantity} {orderItemDeleteTarget.unit}
                  </div>
                </div>
                <p className="text-sm leading-6 text-slate-600">
                  删除后会同步移除该产品关联的供应商报价，重新排列剩余产品行号，并更新订单金额和流程工作簿。此操作不能撤销。
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setOrderItemDeleteTarget(null)}
                  disabled={deletingOrderItem}
                  className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-600 disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void deleteOrderItem()}
                  disabled={deletingOrderItem}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {deletingOrderItem ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  确认删除
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedPhoto && (
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/90 p-3"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSelectedPhoto(null);
            }}
          >
            <div className="flex max-h-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold">
                    {selectedPhoto.sku || "整单质检"} · {selectedPhoto.filename}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">
                    {selectedPhoto.note || "无说明"} ·{" "}
                    {selectedPhoto.uploaded_by_name}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPhoto(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <img
                src={selectedPhoto.attachment_url}
                alt={selectedPhoto.filename}
                className="min-h-0 max-h-[82vh] w-auto max-w-full object-contain"
              />
            </div>
          </div>
        )}

        {tradeAccess?.can_create_customers && (
          <button
            type="button"
            onClick={() => openCustomerModal("manual")}
            className="fixed bottom-4 right-4 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-900 text-white shadow-xl sm:hidden"
            title="录入客户"
          >
            <UserPlus className="h-5 w-5" />
          </button>
        )}
      </div>
    </AuthGuard>
  );
}
