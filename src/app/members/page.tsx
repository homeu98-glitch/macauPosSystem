import { Suspense } from "react";

import { MembersPage } from "@/components/members-page";
import { AuthGuard } from "@/components/auth-guard";

function MembersPageFallback() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
      <div>
        <div className="text-base font-semibold text-slate-900">正在載入會員頁…</div>
        <div className="mt-2 text-sm text-slate-500">請稍候</div>
      </div>
    </div>
  );
}

export default function MembersRoute() {
  return (
    <AuthGuard>
      <Suspense fallback={<MembersPageFallback />}>
        <MembersPage />
      </Suspense>
    </AuthGuard>
  );
}
