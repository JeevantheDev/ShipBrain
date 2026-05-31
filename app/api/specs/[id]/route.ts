import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTIAL_UUID_REGEX = /^[0-9a-f-]{7,36}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cleanId = id.trim().toLowerCase();

  // 1. If it's a full UUID, query directly
  if (FULL_UUID_REGEX.test(cleanId)) {
    const { data: spec, error } = await supabase
      .from("specs")
      .select("*")
      .eq("id", cleanId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: "Failed to fetch spec", detail: error.message }, { status: 500 });
    }

    if (!spec) {
      return NextResponse.json({ error: "Spec not found" }, { status: 404 });
    }

    return NextResponse.json(spec);
  }

  // 2. If it's a partial UUID prefix, fetch and search in JS
  if (PARTIAL_UUID_REGEX.test(cleanId)) {
    const { data: allSpecs, error: specError } = await supabase
      .from("specs")
      .select("*");

    if (specError) {
      return NextResponse.json({ error: "Failed to fetch specs", detail: specError.message }, { status: 500 });
    }

    const searchTarget = cleanId.replace(/-/g, "");
    const spec = allSpecs?.find(s => {
      const cleanDbId = s.id.replace(/-/g, "").toLowerCase();
      return cleanDbId.startsWith(searchTarget);
    }) ?? null;

    if (!spec) {
      return NextResponse.json({ error: "Spec not found" }, { status: 404 });
    }

    return NextResponse.json(spec);
  }

  // 3. Invalid format
  return NextResponse.json({ error: "Invalid spec ID format" }, { status: 400 });
}

