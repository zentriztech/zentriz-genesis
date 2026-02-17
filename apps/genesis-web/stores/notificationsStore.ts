"use client";

import { makeAutoObservable } from "mobx";
import type { Notification } from "@/types";

const mockNotifications: Notification[] = [
  {
    id: "n1",
    userId: "u1",
    type: "project_finished",
    title: "Projeto finalizado",
    body: "API Voucher foi concluído e provisionado.",
    read: false,
    createdAt: new Date().toISOString(),
  },
];

class NotificationsStore {
  list: Notification[] = mockNotifications;

  constructor() {
    makeAutoObservable(this);
  }

  get unreadCount() {
    return this.list.filter((n) => !n.read).length;
  }

  markRead(id: string) {
    const n = this.list.find((x) => x.id === id);
    if (n) n.read = true;
  }

  markAllRead() {
    this.list.forEach((n) => (n.read = true));
  }
}

export const notificationsStore = new NotificationsStore();
