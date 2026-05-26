"use client";

import { Mail, LockKeyhole, UserPlus, LogIn } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const supabase = getSupabaseBrowserClient();

    try {
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        router.replace("/dashboard");
        router.refresh();
        return;
      }

      const signupResponse = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, name })
      });
      const signupJson = await signupResponse.json();
      if (!signupResponse.ok) throw new Error(signupJson.error ?? "Unable to create account");

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      router.replace("/dashboard");
      router.refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="split-list">
      {mode === "signup" ? (
        <label>
          <span className="field-label" style={{ marginTop: 0 }}>Name</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Jeevan" />
        </label>
      ) : null}

      <label>
        <span className="field-label" style={{ marginTop: 0 }}>Email</span>
        <div className="input-with-icon">
          <Mail size={16} />
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" type="email" required />
        </div>
      </label>

      <label>
        <span className="field-label" style={{ marginTop: 0 }}>Password</span>
        <div className="input-with-icon">
          <LockKeyhole size={16} />
          <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Minimum 6 characters" type="password" required />
        </div>
      </label>

      {error ? (
        <div className="error-panel" role="alert" style={{ marginTop: 0 }}>
          <strong>Authentication needs attention</strong>
          <p>{error}</p>
        </div>
      ) : null}
      {message ? (
        <div className="success-panel" role="status" style={{ marginTop: 0 }}>
          <strong>Next step</strong>
          <p>{message}</p>
        </div>
      ) : null}

      <button className="button primary" disabled={busy || !email || !password} style={{ width: "100%" }}>
        {mode === "signin" ? <LogIn size={18} /> : <UserPlus size={18} />}
        {busy ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}
      </button>

      <button className="button secondary" type="button" disabled={busy} onClick={() => setMode(mode === "signin" ? "signup" : "signin")} style={{ width: "100%" }}>
        {mode === "signin" ? "Create an account" : "I already have an account"}
      </button>
    </form>
  );
}
