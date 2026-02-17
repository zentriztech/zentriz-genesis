import pg from "pg";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  (process.env.PGHOST
    ? `postgres://${process.env.PGUSER ?? "genesis"}:${process.env.PGPASSWORD ?? "genesis_dev"}@${process.env.PGHOST}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "zentriz_genesis"}`
    : undefined);

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  tenant_id: string | null;
  role: string;
  status: string;
  created_at: Date;
};

export type TenantRow = {
  id: string;
  name: string;
  plan_id: string;
  status: string;
  created_at: Date;
};

export type ProjectRow = {
  id: string;
  tenant_id: string;
  created_by: string;
  title: string;
  spec_ref: string | null;
  status: string;
  charter_summary: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
