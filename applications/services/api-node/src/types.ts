export type VoucherStatus = "ACTIVE" | "REDEEMED";

export interface Voucher {
  voucherId: string;
  value: number;
  recipient_name: string;
  recipient_document: string;
  status: VoucherStatus;
  createdAt: string;
}

export interface CreateVoucherBody {
  value: number;
  recipient_name: string;
  recipient_document: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  request_id: string;
}
