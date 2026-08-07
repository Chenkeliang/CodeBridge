import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { createWebWorkbenchApp } from "./web-workbench.js";

describe("web workbench", () => {
  it("serves a local conversation workbench with agent and workflow selectors", async () => {
    const store = new SqliteEventStore(":memory:");
    const app = createWebWorkbenchApp({
      store,
      token: "web-token",
      agents: ["pi-investigator", "pi-developer"],
      workflows: [{ id: "price-change", name: "价格调整" }],
    });
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Agent");
    expect(html).toContain("Workflow");
    expect(html).toContain("pi-investigator");
    expect(html).toContain("价格调整");
    expect(html).toContain("/v1/work-items");
    store.close();
  });
});
