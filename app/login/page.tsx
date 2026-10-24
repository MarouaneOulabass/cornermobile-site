"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { mutate } from "swr";
import { Button, ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";

const DEMO_ACCOUNTS = [
  ["consultant@auditflow.demo", "Consultant — 3 missions"],
  ["dirigeant@atlaspro.demo", "Dirigeant AtlasPro"],
  ["finance@atlaspro.demo", "Responsable Finance AtlasPro"],
  ["admin@auditflow.demo", "Administrateur plateforme"],
];

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("consultant@auditflow.demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post("/auth/login", { email, password });
      await mutate("/auth/me");
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <div>
        <div className="text-2xl font-extrabold">
          Audit<span className="text-info">Flow</span>
        </div>
        <p className="mt-1 text-sm text-muted">Vos documents et quelques entretiens : où vous perdez du temps et de l&apos;argent, et dans quel ordre agir.</p>
      </div>
      <label className="block">
        <span className="label">Email</span>
        <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="block">
        <span className="label">Mot de passe</span>
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error ? <ErrorBox error={error} /> : null}
      <Button variant="primary" type="submit" className="w-full" disabled={pending}>
        {pending ? "Connexion…" : "Se connecter"}
      </Button>
      <div className="border-t border-line pt-3">
        <div className="eyebrow mb-2">Comptes de démonstration</div>
        <ul className="space-y-1 text-xs">
          {DEMO_ACCOUNTS.map(([mail, label]) => (
            <li key={mail}>
              <button type="button" className="text-info hover:underline" onClick={() => setEmail(mail)}>
                {mail}
              </button>{" "}
              <span className="text-muted">— {label}</span>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
