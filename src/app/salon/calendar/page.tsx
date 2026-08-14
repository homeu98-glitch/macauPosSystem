import { AuthGuard } from "@/components/auth-guard";
import { CalendarBoard } from "@/components/salon/calendar-board";

export default function SalonCalendarPage() {
  return (
    <AuthGuard>
      <div className="flex h-screen flex-col">
        <CalendarBoard />
      </div>
    </AuthGuard>
  );
}
