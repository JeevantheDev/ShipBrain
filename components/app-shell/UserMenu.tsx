"use client";

import { LogOut, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type UserMenuProps = {
  name: string;
  email?: string;
  avatarUrl?: string;
  variant?: "sidebar" | "topbar";
};

export function UserMenu({ name, email, avatarUrl, variant = "sidebar" }: UserMenuProps) {
  const router = useRouter();

  async function logout() {
    if (variant === "topbar") {
      if (!confirm("Log out of ShipBrain?")) return;
    }
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  if (variant === "topbar") {
    return (
      <div
        className="avatar avatar-top"
        title={`${name} ${email ? `(${email})` : ""} - Click to Log Out`}
        onClick={logout}
        style={{ display: "grid", placeItems: "center" }}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
        ) : (
          name.slice(0, 2).toUpperCase()
        )}
      </div>
    );
  }

  return (
    <div className="user-menu">
      <div className="user-avatar" aria-hidden="true">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <UserRound size={18} />}
      </div>
      <div className="user-copy">
        <strong>{name}</strong>
        {email ? <span>{email}</span> : null}
      </div>
      <button className="icon-button" aria-label="Log out" title="Log out" onClick={logout}>
        <LogOut size={17} />
      </button>
    </div>
  );
}
