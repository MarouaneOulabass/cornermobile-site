"use client";

import { useClerk } from "@clerk/nextjs";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { api } from "@/lib/api";
import { CLERK_ENABLED } from "@/lib/auth";
import { useMe } from "@/lib/hooks/useMe";

type Logout = () => Promise<void>;

function useLocalLogout(): Logout {
  return async () => {
    await api.post("/auth/logout");
  };
}

function useClerkLogout(): Logout {
  const clerk = useClerk();
  return async () => {
    await clerk.signOut();
  };
}

// Fixed for the whole build, so the hook order never changes between renders.
const useLogout = CLERK_ENABLED ? useClerkLogout : useLocalLogout;

export function UserMenu({ dark = false }: { dark?: boolean }) {
  const { me } = useMe();
  const router = useRouter();
  const signOut = useLogout();
  if (!me) return null;
  async function logout() {
    await signOut();
    await mutate(() => true, undefined, { revalidate: false });
    router.replace("/login");
  }
  return (
    <div className={`flex items-center gap-2 text-sm ${dark ? "text-gray-300" : "text-muted"}`}>
      <span className="truncate" title={me.user.email}>
        {me.user.full_name}
      </span>
      <button type="button" onClick={logout} className={`rounded-md p-1.5 ${dark ? "hover:bg-nav-hover" : "hover:bg-gray-100"}`} aria-label="Se déconnecter" title="Se déconnecter">
        <LogOut size={16} />
      </button>
    </div>
  );
}
