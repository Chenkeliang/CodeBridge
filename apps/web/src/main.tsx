import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { setRuntimeToken } from "@/lib/api";
import "@/index.css";

void (async () => {
  const config: { token?: string } = await fetch("/workbench/config.json")
    .then((response) => response.ok ? response.json() as Promise<{ token?: string }> : {} as { token?: string })
    .catch(() => ({} as { token?: string }));
  setRuntimeToken(config.token ?? "");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
