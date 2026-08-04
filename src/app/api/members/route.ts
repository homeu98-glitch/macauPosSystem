import { NextResponse } from "next/server";

import { defaultMembers } from "@/lib/mock-data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const phone = (searchParams.get("phone") ?? "").trim();

  const members = phone
    ? defaultMembers.filter((member) => member.phone.includes(phone))
    : defaultMembers;

  return NextResponse.json({
    ok: true,
    members,
  });
}

