"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { InventoryView } from "@/components/inventory/inventory-view";

export default function InventoryPage() {
  return (
    <>
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <InventoryView />
      </div>
    </>
  );
}
