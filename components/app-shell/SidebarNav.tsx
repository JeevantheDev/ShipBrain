"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, FileText, GitFork, AlertTriangle, Lock } from "lucide-react";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/spec-to-pr", label: "Spec-to-PR", icon: FileText },
  { href: "/ci", label: "CI Monitor", icon: GitFork },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/settings/secrets", label: "Secrets", icon: Lock }
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {nav.map((item) => {
        const Icon = item.icon;
        const active = item.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(item.href);
        return (
          <Link className={active ? "active" : undefined} href={item.href} key={item.href}>
            <Icon size={14} style={{ color: active ? "var(--text)" : "var(--text-muted)", flexShrink: 0 }} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
