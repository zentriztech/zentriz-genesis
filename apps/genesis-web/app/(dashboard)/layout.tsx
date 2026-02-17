"use client";

import { observer } from "mobx-react-lite";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { authStore } from "@/stores/authStore";
import { AppLayout } from "@/components/AppLayout";

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    authStore.hydrate();
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || pathname === "/login") return;
    if (!authStore.isAuthenticated) {
      router.replace("/login");
    }
  }, [hydrated, pathname, router]);

  if (!hydrated || (!authStore.isAuthenticated && pathname !== "/login")) {
    return null;
  }

  return <AppLayout>{children}</AppLayout>;
}

export default observer(DashboardLayoutInner);
