import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Claims Policy Assistant",
  description: "Retrieval-augmented assistant for denied healthcare claims.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
