"use client";

import { AuthGuard } from "@/components/auth-guard";
import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { Checkout } from "@/components/salon/checkout";
import { useParams } from "next/navigation";

export default function SalonCheckoutPage() {
  const params = useParams<{ bookingId: string }>();
  return (
    <AuthGuard>
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-6">
          <Checkout bookingId={params.bookingId} />
        </div>
      </div>
    </AuthGuard>
  );
}
