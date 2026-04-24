"use client";

import { makeAutoObservable, runInAction } from "mobx";
import type { Notification } from "@/types";
import { apiGet, apiPatch, apiDelete } from "@/lib/api";

const POLL_INTERVAL_MS = 30_000;

class NotificationsStore {
  list: Notification[] = [];
  loading = false;
  error: string | null = null;
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  get unreadCount() {
    return this.list.filter((n) => !n.read).length;
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiGet<Notification[]>("/api/notifications");
      runInAction(() => {
        this.list = data;
      });
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : "Erro ao carregar notificações";
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  async markRead(id: string) {
    try {
      const updated = await apiPatch<Notification>(`/api/notifications/${id}/read`, {});
      runInAction(() => {
        const idx = this.list.findIndex((n) => n.id === id);
        if (idx !== -1) this.list[idx] = updated;
      });
    } catch {
      // silently fail — badge will correct on next poll
    }
  }

  async markAllRead() {
    const unread = this.list.filter((n) => !n.read);
    await Promise.allSettled(unread.map((n) => this.markRead(n.id)));
  }

  async remove(id: string) {
    await apiDelete(`/api/notifications/${id}`);
    runInAction(() => {
      this.list = this.list.filter((n) => n.id !== id);
    });
  }

  startPolling() {
    if (this._pollTimer) return;
    void this.load();
    this._pollTimer = setInterval(() => {
      void this.load();
    }, POLL_INTERVAL_MS);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

export const notificationsStore = new NotificationsStore();
