import { AuthGuard } from "@/components/auth-guard";
import { BookingForm } from "@/components/salon/booking-form";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonBookingNewPage() {
  return (
    <AuthGuard>
      <div className="flex h-[100dvh] overflow-hidden bg-slate-100 md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-6">
          <BookingForm />
        </div>
      </div>
    </AuthGuard>
  );
}
