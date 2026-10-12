"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Boxes,
  BriefcaseBusiness,
  Camera,
  CircleDollarSign,
  ClipboardCheck,
  FileText,
  History,
  Lightbulb,
  MessageCircle,
  PackageCheck,
  Settings,
  ShieldCheck,
  Ship,
  ShoppingCart,
  Sparkles,
  Store,
  UserPlus,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";

interface GuideSection {
  id: string;
  title: string;
  icon: LucideIcon;
  who: string;
  steps: ReactNode[];
  tips?: ReactNode[];
  warnings?: ReactNode[];
  blockers?: string[];
}

const FLOW: Array<{ label: string; position: string; icon: LucideIcon; color: string }> = [
  { label: "客户询价", position: "业务员", icon: MessageCircle, color: "bg-amber-50 text-amber-700" },
  { label: "供应商询价", position: "供应商询价", icon: Store, color: "bg-pink-50 text-pink-700" },
  { label: "对客报价与议价", position: "对客报价", icon: CircleDollarSign, color: "bg-sky-50 text-sky-700" },
  { label: "采购执行", position: "采购员", icon: ShoppingCart, color: "bg-violet-50 text-violet-700" },
  { label: "仓库到货", position: "仓库", icon: Warehouse, color: "bg-cyan-50 text-cyan-700" },
  { label: "质量检验", position: "质检员", icon: ClipboardCheck, color: "bg-teal-50 text-teal-700" },
  { label: "装箱贴标", position: "装箱员", icon: Boxes, color: "bg-orange-50 text-orange-700" },
  { label: "物流发货", position: "物流员", icon: Ship, color: "bg-blue-50 text-blue-700" },
  { label: "业务完成", position: "业务负责人", icon: PackageCheck, color: "bg-emerald-50 text-emerald-700" },
];

const B = ({ children }: { children: ReactNode }) => (
  <span className="mx-0.5 inline-flex items-center rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[12px] font-semibold text-slate-700 shadow-sm">
    {children}
  </span>
);

const SECTIONS: GuideSection[] = [
  {
    id: "setup",
    title: "0. 管理员首次配置",
    icon: Settings,
    who: "管理员",
    steps: [
      <>进入外贸业务中心，点击右上角齿轮 <B>职位与外贸设置</B>。</>,
      <>在 <B>职位与交接</B> 中把员工分配到岗位（业务员、供应商询价、对客报价、采购员、仓库、质检员、装箱员、物流员、业务负责人）。一个人可以同时属于多个岗位；某个岗位没人时，由业务单负责人兜底处理。</>,
      <>在 <B>付款方式</B> 中每行填写一种常用付款方式（如 T/T 电汇、30% 定金 70% 尾款），新建询价和 PI 会自动提示。</>,
      <>在 <B>PI 抬头与收款</B> 中填写公司英文名称、地址、联系方式、收款银行（银行名称、SWIFT、账号/IBAN 等），也可以直接上传一张银行账户信息图片。PI 会自动带出这些资料。</>,
      <>在 <B>付款记录权限</B> 中可以单独给员工开放“全部订单凭证”或“仅本人凭证”。</>,
      <>全部设置都要点 <B>保存设置</B> 才会生效。</>,
    ],
    tips: [<>建议先让每个岗位至少有一个人，否则流程推进时提醒不会发到具体员工。</>],
  },
  {
    id: "customer",
    title: "1. 录入客户",
    icon: UserPlus,
    who: "业务员 / 管理员",
    steps: [
      <>点击顶部 <B>录入客户</B>，可以选择 <B>手工录入</B> 或 <B>从 WhatsApp 录入</B>（直接选择聊天，自动带出名字、电话和头像）。</>,
      <>默认勾选 <B>自动建立客户频道</B>：系统会为客户建一个内部频道，后续订单进度、PI 发送都在这里留痕；绑定了 WhatsApp 的频道还会把 PI 转发给客户。</>,
      <>在 <B>客户</B> 页签中可以点 <B>往来订单</B> 查看该客户全部业务单，或点 <B>创建询价</B> 直接为他新建询价。</>,
    ],
    warnings: [<>员工不能直接删除客户，只能 <B>申请删除客户</B> 并填写原因，由管理员在 <B>删除审批</B> 中同意或拒绝。删除后历史订单和频道会保留。</>],
  },
  {
    id: "inquiry",
    title: "2. 新建客户询价（一次录入 10～20 个产品）",
    icon: MessageCircle,
    who: "业务员",
    steps: [
      <>点击右上角 <B>新建询价</B>，选择客户、填写询价主题、报价截止、币种、付款方式和目的地。</>,
      <>在产品表格中每行一个 SKU（SKU 即产品，不再单独填写名称）。数量、单位、目标价、规格和客户要求都可以直接在表格里改，产品多时表格可以上下滑动。</>,
      <>产品很多时点 <B>批量粘贴</B>，把 Excel 或微信里的内容粘进去，每行一个产品，列顺序为“SKU 数量 单位 目标价 规格 备注”。支持 Tab、逗号、两个空格分隔，也支持“AB-1003 x 1000”这种写法。也可以直接把多行内容粘到任意 SKU 格里。</>,
      <>每行左侧的 <B>询价图</B> 用于上传客户发来的参考图片（截图、产品图）。真实到货照片请在质检环节上传。</>,
      <>点击 <B>创建业务单</B>，系统会通知“供应商询价”岗位。</>,
    ],
    tips: [<>在最后一行的 SKU 格中按回车可以快速新增一行。</>],
    blockers: ["每一行都要有 SKU，且数量大于 0"],
  },
  {
    id: "supplier",
    title: "3. 供应商询价与比价",
    icon: Store,
    who: "供应商询价岗",
    steps: [
      <>打开业务单 <B>详情</B>，在“供应商比价”区域点击 <B>录入报价</B>。</>,
      <>弹窗会一次列出订单里的全部产品。可以在顶部选择 <B>统一供应商</B>、币种、交期、有效期，然后点 <B>应用到全部行</B> 或 <B>仅填空白行</B>，再逐行填写单价和 MOQ。</>,
      <>同一个 SKU 要比较多家供应商时，点该行右侧的复制按钮，新增一行“同 SKU 另一家”。</>,
      <>只会保存填了供应商和单价的行，没报价的产品可以稍后再补。</>,
      <>在比价列表中为每个产品点 <B>采用</B> 选定供应商，然后推进到对客报价。</>,
    ],
    blockers: ["每个产品都必须采用一个供应商报价"],
  },
  {
    id: "quotation",
    title: "4. 对客报价与议价",
    icon: CircleDollarSign,
    who: "对客报价岗 / 业务负责人",
    steps: [
      <>在详情中点 <B>新建报价轮次</B>。填写报价币种、兑人民币汇率、运费方式（客户自有货代，或我方报价运费），然后逐个填写对客单价。</>,
      <>管理员和业务负责人可以看到采购参考价和 <B>成本加价率</B>：填一个加价率后点 <B>重新计算</B>，会按“采购价 × 汇率换算 × (1 + 加价率)”自动生成售价。员工看不到成本，只能手工报价。</>,
      <>保存时可以选 <B>已向客户报价</B> 或 <B>仅保存草稿</B>。每一轮都会保留，方便回看议价过程。</>,
      <>客户反馈后在报价卡片上点 <B>客户砍价</B>、<B>客户接受</B> 或 <B>客户拒绝</B>，并记录客户反馈。砍价或拒绝后可以点 <B>基于本轮重新报价</B> 生成下一轮。</>,
      <>客户接受后，可以在该轮报价上 <B>登记付款</B>（未付款/部分付款/已付款），并 <B>添加付款凭证</B>（图片或 PDF）。</>,
    ],
    warnings: [<>只能接受最新一轮报价；新建一轮后，旧的草稿、已发送和已接受轮次会自动标记为“已被新报价替代”。</>],
    blockers: ["必须有一轮“客户已接受”的报价", "非人民币报价必须填写兑人民币汇率"],
  },
  {
    id: "pi",
    title: "5. 生成并发送 PI（形式发票）",
    icon: FileText,
    who: "业务单负责人 / 业务负责人 / 管理员",
    steps: [
      <>前提：至少有一轮已发送（非草稿、非拒绝）的对客报价，并且管理员已在设置中填好 PI 抬头。</>,
      <>在详情顶部点 <B>生成 PI</B>，选择 <B>报价轮次</B>（默认选已接受的一轮）。核对开具日期（默认今天）、有效期至（默认 14 天后）、付款方式、交付条款（默认带出贸易术语和目的地）、交货时间和本次备注。</>,
      <>同一个客户要用不同的卖方主体时，点 <B>编辑本次资料</B> 修改公司名称、联系人、税号等，只对这一轮生效。</>,
      <>要换收款账户时，可以在 <B>点击或拖入本次 PI 收款图片</B> 处上传本次专用的银行信息图片。图片按“本轮图片 → 设置里的默认图片 → 文字银行资料”的顺序使用。</>,
      <>点 <B>PDF 预览</B> 检查，然后 <B>下载 PDF</B> 或 <B>发送客户</B>。发送会把 PDF 发到客户频道；如果频道绑定了 WhatsApp，会同时转发给客户（不会发邮件）。</>,
    ],
    tips: [<>PI 编号格式为 PI-业务单号-R轮次，例如 PI-FT-20261012-000001-R2，便于和报价轮次对应。</>],
    warnings: [<>客户没有关联频道时，<B>发送客户</B> 按钮不可用，可以先下载 PDF 再手动发送。</>],
  },
  {
    id: "purchase",
    title: "6. 采购执行",
    icon: ShoppingCart,
    who: "采购员",
    steps: [
      <>在详情中点 <B>编辑当前环节数据</B>，为每个产品填写供应商、采购币种、采购价、成本换算率和采购状态（已下单/生产中/已完成）。</>,
      <>页面会显示“采购前客户付款核对”，方便确认客户定金是否到账。</>,
    ],
    blockers: ["每个产品都有供应商和大于 0 的采购价", "采购状态为 已下单 / 生产中 / 已完成"],
  },
  {
    id: "receiving",
    title: "7. 仓库到货",
    icon: Warehouse,
    who: "仓库",
    steps: [<>货到后在 <B>编辑当前环节数据</B> 中填写实到数量、库位、到货日期和到货状态。</>],
    blockers: ["实到数量 ≥ 订单数量"],
  },
  {
    id: "inspection",
    title: "8. 质量检验（手机拍照）",
    icon: Camera,
    who: "质检员",
    steps: [
      <>用手机打开业务单详情，在“质检照片”处点 <B>拍照 / 选图上传</B>；也可以在产品表格中点某个 SKU 旁的相机按钮，直接拍该产品。</>,
      <>弹出的面板可以选 <B>拍照</B>（调用后置摄像头）、<B>手机相册</B> 或 <B>系统图库</B>，连续添加多张。方向不对时，在上传前点旋转按钮调整。上传时会自动压缩，并按手机拍摄方向保存。</>,
      <>上传后的照片点开还可以继续旋转或翻转。这些到货实拍图会作为“产品报价库”中该 SKU 的主图。</>,
      <>在 <B>编辑当前环节数据</B> 中填写抽检数量、合格数量、质检结论和问题描述。</>,
    ],
    blockers: ["合格数量 ≥ 实到数量（且实到数量 > 0）", "至少上传一张质检照片"],
  },
  {
    id: "packing",
    title: "9. 装箱贴标与 SKU 箱唛打印",
    icon: Boxes,
    who: "装箱员",
    steps: [
      <>点 <B>编辑装箱组合</B>，按实际装法录入：长、宽、高、实重、相同箱数、同箱产品和每箱数量。有多种装法时点 <B>添加另一种装箱方式</B>。保存后会自动更新装箱数量和标签份数。</>,
      <>点 <B>SKU 标签</B> 进入打印页。热敏标签机选 <B>标签打印机</B> 模式（每张纸一个标签）；普通打印机选 <B>A4 拼版</B>。</>,
      <>可以选择尺寸预设（如 100×60、100×150），勾选要显示的内容（客户、单号、目的地、规格、箱号 C/NO、箱规毛重、SKU 条码），再修改底部文字。</>,
      <>打印时在浏览器打印对话框中选标签打印机，纸张选与标签相同的尺寸，边距选“无”，缩放选 100%。</>,
    ],
    blockers: ["装箱数量 ≥ 合格数量", "箱数 > 0"],
  },
  {
    id: "shipment",
    title: "10. 物流发货",
    icon: Ship,
    who: "物流员",
    steps: [
      <>在 <B>编辑当前环节数据</B> 中填写物流公司（DHL / FedEx）、物流订单号和运输状态。</>,
      <>如果报价时选了“我方报价运费”，还需要填写最终实际运费、币种和兑人民币汇率，系统会单独计算运费利润。</>,
    ],
    blockers: ["运输状态为 已发货", "已上传客户付款凭证", "我方报价运费时必须填写实际运费"],
  },
  {
    id: "finish",
    title: "11. 完成、利润与老板面板",
    icon: PackageCheck,
    who: "业务负责人 / 管理员",
    steps: [
      <>业务负责人确认后推进到 <B>业务完成</B>。</>,
      <>在详情中点 <B>成本与汇率</B>，可以补充附加成本和产品成本换算率，然后点 <B>保存并重算</B>，订单利润汇总会实时更新。</>,
      <>在 <B>老板面板</B> 中查看月度盈利、人民币和分币种经营汇总、利润最高和亏损关注的订单。</>,
    ],
  },
  {
    id: "products",
    title: "产品报价库：查历史报价和货物图片",
    icon: History,
    who: "全部外贸员工",
    steps: [
      <>点击 <B>产品报价库</B> 页签，默认按图片卡片展示所有报过价的 SKU。主图优先用到货/质检实拍，没有实拍时显示客户询价图。</>,
      <>可以搜索 SKU、规格或业务单号，按客户筛选，或点 <B>仅成交价</B> 只看客户接受的报价。</>,
      <>点卡片查看该 SKU 每一次报价的日期、客户、业务单和轮次、对客单价和全部图片；点业务单号可以直接打开订单。</>,
      <>可以切换到 <B>列表</B> 视图，按行快速浏览价格区间和报价次数。</>,
    ],
    warnings: [<>员工只能看到对客报价（已含利润）；采购价、供应商、加价率、单件利润和利润率只有管理员和业务负责人可见。其他业务员客户的名称对员工隐藏。</>],
  },
  {
    id: "ai",
    title: "AI 智能建单",
    icon: Sparkles,
    who: "业务员 / 管理员",
    steps: [
      <>适用于货已下单、需要补录进系统的订单。点 <B>AI 智能建单</B>，把聊天记录、报价单或付款信息粘进“粘贴原始资料”。</>,
      <>点 <B>识别订单资料</B> 生成可编辑草稿，核对客户、产品 SKU、数量和金额，然后点 <B>创建并进入到货</B>。</>,
      <>订单会直接从仓库到货开始。识别不全的字段补齐后，在详情中点 <B>确认已补齐</B> 才能继续推进。</>,
    ],
  },
];

const PERMISSIONS: Array<[string, string, string]> = [
  ["对客报价（含利润的售价）", "可见（本人负责或当前任务）", "可见"],
  ["采购价 / 供应商报价", "仅当前环节的采购、供应商询价岗，且看不到售价", "可见"],
  ["加价率 / 单件利润 / 订单利润", "不可见", "可见"],
  ["实际运费成本", "不可见", "可见"],
  ["其他业务员的客户联系方式", "不可见", "可见"],
  ["产品报价库", "售价 + 图片", "售价 + 成本 + 利润"],
  ["取消业务单", "仅本人负责的业务单", "可以"],
  ["删除订单 / 客户 / 供应商", "不可以（客户可申请删除）", "管理员可以"],
];

export default function TradeGuidePage() {
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-90px 0px -60% 0px" },
    );
    SECTIONS.forEach((section) => {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100 text-slate-900">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex min-h-14 max-w-[1280px] items-center justify-between gap-3 px-3 py-2 md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/trade"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                title="返回外贸业务中心"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold md:text-lg">外贸 ERP 使用教程</h1>
                <p className="truncate text-xs text-slate-500">从录入客户到发货完成的完整操作说明</p>
              </div>
            </div>
            <Link
              href="/trade"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white"
            >
              <BriefcaseBusiness className="h-4 w-4" />
              <span className="hidden sm:inline">去业务中心</span>
            </Link>
          </div>
          <nav className="flex gap-1.5 overflow-x-auto border-t border-slate-100 px-3 py-2 [scrollbar-width:none] lg:hidden">
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className={`h-8 shrink-0 rounded-full px-3 text-xs font-medium leading-8 ${active === section.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
              >
                {section.title.replace(/^\d+\.\s*/, "")}
              </a>
            ))}
          </nav>
        </header>

        <div className="mx-auto grid max-w-[1280px] gap-5 p-3 md:p-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <nav className="sticky top-20 space-y-0.5 rounded-lg border border-slate-200 bg-white p-2">
              {SECTIONS.map((section) => {
                const Icon = section.icon;
                return (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${active === section.id ? "bg-slate-900 font-semibold text-white" : "text-slate-600 hover:bg-slate-50"}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{section.title}</span>
                  </a>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0 space-y-4">
            <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
              <div className="flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-sky-700" />
                <h2 className="text-base font-semibold">整体流程</h2>
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                每张业务单按以下 9 个环节流转。每个环节由对应岗位处理，完成“推进前还需完成”的条件后，点击 <B>推进到下一环节</B>；发现问题可以 <B>退回上一环节</B>，到货后发现采购问题可以用 <B>采购/发货异常</B> 退回采购。
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
                {FLOW.map((stage, index) => {
                  const Icon = stage.icon;
                  return (
                    <div key={stage.label} className={`relative rounded-lg px-3 py-2.5 ${stage.color}`}>
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold opacity-70">
                        <span>{index + 1}</span>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="mt-1 text-sm font-semibold">{stage.label}</div>
                      <div className="text-[11px] opacity-80">{stage.position}</div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 grid gap-2 text-sm text-slate-600 md:grid-cols-3">
                <div className="rounded-lg bg-slate-50 p-3">
                  <strong className="text-slate-800">谁能处理？</strong> 管理员、业务负责人和该环节岗位成员；岗位没有成员时，由业务单负责人兜底。客户询价阶段只有该单的业务员本人能处理。
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <strong className="text-slate-800">怎么知道轮到我？</strong> 业务单列表的“负责职位”一列会标出“可处理”，推进时系统也会通知下一岗位。
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <strong className="text-slate-800">手机能用吗？</strong> 可以。底部导航进入“外贸”，所有环节都能在手机上处理，质检可以直接拍照上传。
                </div>
              </div>
            </section>

            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <section
                  key={section.id}
                  id={section.id}
                  className="scroll-mt-28 rounded-lg border border-slate-200 bg-white p-4 md:p-5 lg:scroll-mt-20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
                        <Icon className="h-4 w-4" />
                      </span>
                      <h2 className="text-base font-semibold">{section.title}</h2>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                      操作人：{section.who}
                    </span>
                  </div>
                  <ol className="mt-4 space-y-2.5">
                    {section.steps.map((step, index) => (
                      <li key={index} className="flex gap-3 text-sm leading-7 text-slate-700">
                        <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-semibold text-sky-700">
                          {index + 1}
                        </span>
                        <span className="min-w-0">{step}</span>
                      </li>
                    ))}
                  </ol>
                  {section.blockers && (
                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="text-xs font-semibold text-slate-700">推进到下一环节前必须满足</div>
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {section.blockers.map((blocker) => (
                          <li key={blocker} className="rounded-md bg-white px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200">
                            ✓ {blocker}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {section.tips?.map((tip, index) => (
                    <div key={index} className="mt-3 flex gap-2 rounded-lg bg-emerald-50 p-3 text-sm leading-6 text-emerald-900">
                      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{tip}</span>
                    </div>
                  ))}
                  {section.warnings?.map((warning, index) => (
                    <div key={index} className="mt-3 flex gap-2 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </section>
              );
            })}

            <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-slate-700" />
                <h2 className="text-base font-semibold">权限一览</h2>
              </div>
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2">数据 / 操作</th>
                      <th className="px-3 py-2">普通员工</th>
                      <th className="px-3 py-2">管理员 / 业务负责人</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PERMISSIONS.map(([label, employee, admin]) => (
                      <tr key={label} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium text-slate-700">{label}</td>
                        <td className="px-3 py-2 text-slate-600">{employee}</td>
                        <td className="px-3 py-2 text-slate-600">{admin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}
