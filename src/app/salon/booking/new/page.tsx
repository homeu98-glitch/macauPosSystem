import { AuthGuard } from "@/components/auth-guard";
import { BookingForm } from "@/components/salon/booking-form";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonBookingNewPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen bg-slate-100 md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 py-6">
          <div className="mx-auto max-w-2xl px-4">
            <BookingForm />
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
