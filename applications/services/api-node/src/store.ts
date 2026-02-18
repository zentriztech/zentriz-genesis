import type { Voucher } from "./types.js";

const store = new Map<string, Voucher>();

export function saveVoucher(v: Voucher): void {
  store.set(v.voucherId, v);
}

export function getVoucher(id: string): Voucher | undefined {
  return store.get(id);
}

export function listVouchers(page = 1, pageSize = 20): { items: Voucher[]; total: number } {
  const all = Array.from(store.values());
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, total: store.size };
}
