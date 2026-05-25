"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, GitPullRequest, Settings, Siren, TestTube2 } from "lucide-react";

const nav = [
  { href: "/", label: "Dashboard", icon: Activity },
  { href: "/spec-to-pr", label: "Spec-to-PR", icon: GitPullRequest },
  { href: "/ci", label: "CI Monitor", icon: TestTube2 },
  { href: "/incidents", label: "Incidents", icon: Siren },
  { href: "/settings/secrets", label: "Secrets", icon: Settings }
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {nav.map((item) => {
        const Icon = item.icon;
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link className={active ? "active" : undefined} href={item.href} key={item.href}>
            <Icon size={18} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
