import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/agent/auth";
import { getShipBrainAgentContext } from "@/lib/agent/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const context = await getShipBrainAgentContext({
      supabase: auth.supabase,
      userId: auth.userId,
      repoFullName: auth.repoFullName
    });
    return NextResponse.json(context);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Unable to load ShipBrain agent context.",
        detail: error instanceof Error ? error.message : "Unexpected context error."
      },
      { status: 500 }
    );
  }
}
