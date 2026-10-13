import type { TradeOrderItem } from "@/types";

type WithWorkflow = Pick<TradeOrderItem, "workflow_data"> | null | undefined;

/** No supplier can provide the product; marked during supplier quoting. */
export function tradeItemUnavailable(item: WithWorkflow) {
  return item?.workflow_data?.supplier_unavailable === true;
}

export function tradeItemUnavailableReason(item: WithWorkflow) {
  const reason = item?.workflow_data?.supplier_unavailable_reason;
  return typeof reason === "string" ? reason : "";
}

/** Quoted, but the customer did not buy it when accepting the quote. */
export function tradeItemDeclined(item: WithWorkflow) {
  return item?.workflow_data?.customer_declined === true;
}

/** Products that leave the workflow after quoting. */
export function tradeItemExcluded(item: WithWorkflow) {
  return tradeItemUnavailable(item) || tradeItemDeclined(item);
}

export function tradeActiveItems<T extends Pick<TradeOrderItem, "workflow_data">>(items: T[] | null | undefined): T[] {
  return (items || []).filter((item) => !tradeItemExcluded(item));
}
