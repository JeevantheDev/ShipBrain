import { createClient } from "@supabase/supabase-js";
import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/supabase/env";

type AuthenticatedUser = {
  email?: string | null;
};

export async function requirePasswordConfirmation(user: AuthenticatedUser, password: unknown) {
  const value = typeof password === "string" ? password : "";
  if (!value.trim()) {
    throw new Error("Confirm your password to continue.");
  }
  if (!user.email) {
    throw new Error("Password confirmation is only available for email/password accounts.");
  }

  const authClient = createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { error } = await authClient.auth.signInWithPassword({
    email: user.email,
    password: value
  });

  if (error) {
    throw new Error("Password confirmation failed. Check your password and try again.");
  }
}
