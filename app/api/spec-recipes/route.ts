import { NextResponse } from "next/server";
import { DEFAULT_SPEC_PR_RECIPES, type SpecPrRecipe } from "@/lib/spec-recipes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function toRecipe(row: any): SpecPrRecipe {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    baseBranch: row.base_branch ?? "develop",
    sourceBranch: row.source_branch ?? undefined,
    ticket: row.ticket,
    isSample: row.is_sample ?? false,
    sortOrder: row.sort_order ?? 100
  };
}

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("spec_pr_recipes")
    .select("id, label, prefix, base_branch, source_branch, ticket, is_sample, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    return NextResponse.json({
      recipes: DEFAULT_SPEC_PR_RECIPES,
      warning: "Spec-to-PR recipes are using local defaults until migration 035_spec_pr_recipes.sql is applied.",
      detail: error.message
    });
  }

  const recipes = (data ?? []).map(toRecipe);
  return NextResponse.json({ recipes: recipes.length ? recipes : DEFAULT_SPEC_PR_RECIPES });
}
