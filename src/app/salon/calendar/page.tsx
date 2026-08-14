import { AuthGuard } from "@/components/auth-guard";
import { CalendarBoard } from "@/components/salon/calendar-board";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonCalendarPage() {
  return (
    <AuthGuard>
      <div className="flex h-screen flex-col md:pl-[72px]">
        <SalonSidebar />
        <CalendarBoard />
      </div>
    </AuthGuard>
  );
}
