import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "AuditFlow — Audit IA & Performance",
  description: "Diagnostic opérationnel traçable, chiffré et priorisé.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const page = (
    <html lang="fr" className={inter.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
  // Clerk in deployed environments; local demo accounts otherwise.
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? <ClerkProvider signInUrl="/login">{page}</ClerkProvider> : page;
}
