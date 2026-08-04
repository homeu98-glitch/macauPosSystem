import { NextResponse } from "next/server";

import { mockBootstrap } from "@/lib/mock-data";

export async function GET() {
  return NextResponse.json(mockBootstrap);
}
