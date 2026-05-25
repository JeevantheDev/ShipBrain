"use client";

import { LogOut, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type UserMenuProps = {
  name: string;
  email?: string;
  avatarUrl?: string;
};

export function UserMenu({ name, email, avatarUrl }: UserMenuProps) {
  const router = useRouter();

  async function logout() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    window.localStorage.removeItem("shipbrain:selectedRepo");
    window.localStorage.removeItem("shipbrain:connectedRepos");
    router.replace("/login");
    router.refresh();
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
