import { AuthGuard } from "@/components/auth-guard";
import { BookingForm } from "@/components/salon/booking-form";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonBookingNewPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen bg-slate-100 md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 py-6 pb-24 md:pb-6">
          <div className="mx-auto w-full max-w-4xl px-4">
            <BookingForm />
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
