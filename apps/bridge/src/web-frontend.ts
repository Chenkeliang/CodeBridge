import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";

export interface WebFrontendOptions {
  staticDirectory: string;
  token?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=UTF-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=UTF-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".map": "application/json; charset=UTF-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Serves the optional Vite build without adding a second backend contract. */
export function createWebFrontendApp(options: WebFrontendOptions): Hono {
  const app = new Hono();

  app.get("/config.json", (c) => {
    return c.json({ token: options.token ?? "" }, 200, {
      "cache-control": "no-store",
    });
  });

  app.get("*", async (c) => {
    const requestedPath = decodeURIComponent(new URL(c.req.url).pathname);
    const pathname = requestedPath === "/workbench"
      ? "/"
      : requestedPath.startsWith("/workbench/")
        ? requestedPath.slice("/workbench".length)
        : requestedPath;
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (relative === "config.json" || relative.includes("..")) {
      return c.notFound();
    }

    const direct = await readFile(options.staticDirectory, relative);
    if (direct) return directResponse(direct, relative);

    // Client-side routes are rendered by the same React entry point.
    if (!path.extname(relative)) {
      const fallback = await readFile(options.staticDirectory, "index.html");
      if (fallback) return directResponse(fallback, "index.html");
    }
    return c.notFound();
  });

  return app;
}

async function readFile(root: string, relative: string): Promise<Buffer | undefined> {
  const target = path.resolve(root, relative);
  const rootPath = path.resolve(root);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) return undefined;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return undefined;
    return await fs.readFile(target);
  } catch {
    return undefined;
  }
}

function directResponse(content: Buffer, relative: string): Response {
  const extension = path.extname(relative).toLowerCase();
  return new Response(content, {
    headers: {
      "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    },
  });
}
