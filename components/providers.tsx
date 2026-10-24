"use client";

import { SWRConfig } from "swr";
import { ApiError, fetcher } from "@/lib/api";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: false,
        shouldRetryOnError: (err) => !(err instanceof ApiError && err.status < 500),
      }}
    >
      {children}
    </SWRConfig>
  );
}
