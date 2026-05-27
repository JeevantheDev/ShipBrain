"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

export function Crumbs() {
  const pathname = usePathname();
  const [repo, setRepo] = useState("JeevantheDev/shipbrain_sandbox");

  useEffect(() => {
    const savedRepo = localStorage.getItem("shipbrain:selectedRepo");
    if (savedRepo) setRepo(savedRepo);
    
    // Listen to changes in localStorage
    const handleStorageChange = () => {
      const current = localStorage.getItem("shipbrain:selectedRepo");
      if (current) setRepo(current);
    };
    window.addEventListener("storage", handleStorageChange);
    // Periodically poll since 'storage' event only fires across tabs
    const interval = setInterval(handleStorageChange, 1000);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  const segments = repo.split("/");
  const org = segments[0] || "JeevantheDev";
  const repoName = segments[1] || "shipbrain_sandbox";
  
  let pageName = "Dashboard";
  if (pathname.includes("/spec-to-pr")) pageName = "Spec-to-PR";
  else if (pathname.includes("/ci")) pageName = "CI Monitor";
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
