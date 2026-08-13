import { Suspense } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { MemberTopupPage } from "@/components/member-topup-page";

export default function TopupRoute() {
  return (
    <AuthGuard>
      <Suspense
        fallback={
          <div className="grid h-[100dvh] place-items-center bg-slate-100 text-sm text-slate-500">載入充值審核…</div>
        }
      >
        <MemberTopupPage />
      </Suspense>
    </AuthGuard>
  );
}
