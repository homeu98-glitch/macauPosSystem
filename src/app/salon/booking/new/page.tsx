import { AuthGuard } from "@/components/auth-guard";
import { BookingForm } from "@/components/salon/booking-form";
import Link from "next/link";

export default function SalonBookingNewPage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100 py-6">
        <div className="mx-auto max-w-2xl px-4">
          <div className="mb-4 flex items-center gap-3">
            <Link
              href="/salon"
              className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
            >
              ← 工作台
            </Link>
            <Link
              href="/salon/calendar"
              className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
            >
              看板
            </Link>
          </div>
          <BookingForm />
        </div>
      </div>
    </AuthGuard>
  );
}
