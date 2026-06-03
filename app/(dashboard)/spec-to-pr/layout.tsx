import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Spec-to-PR | ShipBrain",
  description: "Transform task specifications and feature requests into fully structured plan suggestions and draft PRs."
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
