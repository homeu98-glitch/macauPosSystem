import { NextResponse } from "next/server";

import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { mockBootstrap } from "@/lib/mock-data";

export async function GET() {
  return NextResponse.json(normalizeBootstrapPayload(mockBootstrap));
}
