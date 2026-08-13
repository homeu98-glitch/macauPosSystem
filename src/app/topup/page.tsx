import { redirect } from "next/navigation";

export default function TopupRoute() {
  redirect("/members?tab=topup");
}
