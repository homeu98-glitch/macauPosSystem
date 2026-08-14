"use client";

import { AuthGuard } from "@/components/auth-guard";
import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { Checkout } from "@/components/salon/checkout";
import { useParams } from "next/navigation";

export default function SalonCheckoutPage() {
  const params = useParams<{ bookingId: string }>();
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <Checkout bookingId={params.bookingId} />
        </div>
      </div>
    </AuthGuard>
  );
}
