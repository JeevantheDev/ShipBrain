"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

export function Crumbs() {
  const pathname = usePathname();
  const [repo, setRepo] = useState("JeevantheDev/shipbrain_sandbox");

  useEffect(() => {
    let cancelled = false;

    async function loadActiveRepo() {
      const response = await fetch("/api/github/active-repo", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const json = await response.json();
      if (!cancelled && json.activeRepoFullName) setRepo(json.activeRepoFullName);
    }

    function handleActiveRepo(event: Event) {
      const nextRepo = (event as CustomEvent<string>).detail;
      if (nextRepo) setRepo(nextRepo);
    }

    void loadActiveRepo();
    window.addEventListener("shipbrain:active-repo", handleActiveRepo);
    return () => {
      cancelled = true;
      window.removeEventListener("shipbrain:active-repo", handleActiveRepo);
    };
  }, []);

  const segments = repo.split("/");
  const org = segments[0] || "JeevantheDev";
  const repoName = segments[1] || "shipbrain_sandbox";
  
  let pageName = "Dashboard";
  if (pathname.includes("/spec-to-pr")) pageName = "Spec-to-PR";
  else if (pathname.includes("/ci")) pageName = "CI Monitor";
  else if (pathname.includes("/releases")) pageName = "Release Trace";
  else if (pathname.includes("/incidents")) pageName = "Incidents";
  else if (pathname.includes("/settings")) pageName = "Settings";

  return (
    <nav className="crumbs">
      <Link href="/dashboard">{org}</Link>
      <span className="sep">/</span>
      <Link href="/dashboard">{repoName}</Link>
      <span className="sep">/</span>
      <span className="current">{pageName}</span>
    </nav>
  );
}
