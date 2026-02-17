"use client";

import { makeAutoObservable } from "mobx";
import type { User, Tenant } from "@/types";
import { apiPost } from "@/lib/api";

export const PLANS = [
  { id: "prata", slug: "prata" as const, name: "Prata", maxProjects: 3, maxUsersPerTenant: 5 },
  { id: "ouro", slug: "ouro" as const, name: "Ouro", maxProjects: 10, maxUsersPerTenant: 20 },
  { id: "diamante", slug: "diamante" as const, name: "Diamante", maxProjects: 50, maxUsersPerTenant: 100 },
];

type LoginResponse = {
  token: string;
  user: User;
  tenant: Tenant | null;
};

class AuthStore {
  user: User | null = null;
  tenant: Tenant | null = null;
  token: string | null =
    typeof window !== "undefined" ? localStorage.getItem("genesis_token") : null;
  loginError: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  get isZentrizAdmin() {
    return this.user?.role === "zentriz_admin";
  }

  get isTenantAdmin() {
    return this.user?.role === "tenant_admin" || this.isZentrizAdmin;
  }

  get isAuthenticated() {
    return !!this.token && !!this.user;
  }

  /** expectedRole: se informado, exige que o usuário retornado tenha esse role; caso contrário falha com mensagem. */
  async login(
    email: string,
    password: string,
    expectedRole?: "user" | "tenant_admin" | "zentriz_admin"
  ) {
    this.loginError = null;
    try {
      const data = await apiPost<LoginResponse>("/api/auth/login", { email, password });
      if (expectedRole && data.user.role !== expectedRole) {
        this.loginError =
          expectedRole === "zentriz_admin"
            ? "Use a tela de login Zentriz (Portal Genesis)."
            : expectedRole === "tenant_admin"
              ? "Use a tela de login Admin do tenant."
              : "Use a tela de login Usuário.";
        throw new Error(this.loginError);
      }
      this.token = data.token;
      this.user = data.user;
      this.tenant = data.tenant ?? null;
      if (typeof window !== "undefined") {
        localStorage.setItem("genesis_token", data.token);
        localStorage.setItem("genesis_user", JSON.stringify(data.user));
        localStorage.setItem("genesis_tenant", data.tenant ? JSON.stringify(data.tenant) : "");
      }
    } catch (err) {
      if (!this.loginError) this.loginError = err instanceof Error ? err.message : "Falha no login";
      throw err;
    }
  }

  hydrate() {
    if (typeof window === "undefined") return;
    const t = localStorage.getItem("genesis_token");
    const u = localStorage.getItem("genesis_user");
    const tn = localStorage.getItem("genesis_tenant");
    if (t && u) {
      try {
        this.token = t;
        this.user = JSON.parse(u) as User;
        this.tenant = tn ? (JSON.parse(tn) as Tenant) : null;
      } catch {
        this.token = null;
        this.user = null;
        this.tenant = null;
      }
    }
  }

  logout() {
    this.user = null;
    this.tenant = null;
    this.token = null;
    this.loginError = null;
    if (typeof window !== "undefined") {
      localStorage.removeItem("genesis_token");
      localStorage.removeItem("genesis_user");
      localStorage.removeItem("genesis_tenant");
    }
  }

  setUser(user: User | null) {
    this.user = user;
  }

  setTenant(tenant: Tenant | null) {
    this.tenant = tenant;
  }
}

export const authStore = new AuthStore();
