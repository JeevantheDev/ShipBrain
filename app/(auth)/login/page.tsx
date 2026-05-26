import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/AuthForm";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) redirect("/dashboard");

  return (
    <main style={{ display: "grid", minHeight: "100vh", placeItems: "center", padding: 24 }}>
      <section className="panel" style={{ width: "min(460px, 100%)" }}>
        <div className="brand" style={{ color: "var(--ink)", marginBottom: 20 }}>
          <div className="brand-mark">SB</div>
          <div>
            <strong>ShipBrain</strong>
            <p style={{ marginBottom: 0 }}>Sign in first, then connect GitHub and your working repositories.</p>
          </div>
        </div>
        <AuthForm />
      </section>
    </main>
  );
}
