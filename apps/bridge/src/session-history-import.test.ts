import { describe, expect, it, vi } from "vitest";
import { SessionCatalogStore } from "@codebridge/session-catalog";
import { SqliteEventStore } from "@codebridge/work-items";
import type { RunnerClient } from "@codebridge/runner-client";
import { ProviderHistoryImporter } from "./session-history-import.js";

function setupImportedSession() {
  const store = new SqliteEventStore(":memory:");
  const catalog = new SessionCatalogStore(":memory:");
  const session = catalog.createSession({
    agentId: "pi",
    title: "Imported Session",
    cwd: "/workspace",
    providerSessionId: "provider_1",
  });
  const runner = {
    loadSessionHistory: vi.fn(),
  } as unknown as RunnerClient;
  return { store, catalog, runner, session };
}

describe("ProviderHistoryImporter", () => {
  it("previews without changing SQLite", async () => {
    const { store, catalog, runner, session } =
      setupImportedSession();
    vi.mocked(runner.loadSessionHistory).mockResolvedValue([
      { kind: "message", text: "old question" },
      {
        kind: "agent_event",
        event: {
          type: "text_delta",
          blockId: "answer",
          text: "old answer",
        },
      },
    ]);
    const importer = new ProviderHistoryImporter({
      store,
      catalog,
      runner,
    });
    const before = store.countAllChanges();

    const preview = await importer.preview(session.id);

    expect(preview).toMatchObject({
      importableEvents: 2,
      importedPosition: 0,
    });
    expect(store.countAllChanges()).toBe(before);
    catalog.close();
    store.close();
  });

  it("imports each Provider position once", async () => {
    const { store, catalog, runner, session } =
      setupImportedSession();
    vi.mocked(runner.loadSessionHistory).mockResolvedValue([
      { kind: "message", text: "old question" },
      {
        kind: "agent_event",
        event: {
          type: "text_delta",
          blockId: "answer",
          text: "old answer",
        },
      },
    ]);
    const importer = new ProviderHistoryImporter({
      store,
      catalog,
      runner,
    });

    const first = await importer.import(session.id, "import_1");
    const second = await importer.import(session.id, "import_1");

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      importedEvents: 2,
      importedTurns: 1,
    });
    expect(
      store.listTimelineTurns(session.id, { limit: 50 }).turns,
    ).toHaveLength(1);
    catalog.close();
    store.close();
  });

  it("rejects changed Provider history before the imported cursor", async () => {
    const { store, catalog, runner, session } =
      setupImportedSession();
    const importer = new ProviderHistoryImporter({
      store,
      catalog,
      runner,
    });
    vi.mocked(runner.loadSessionHistory).mockResolvedValue([
      { kind: "message", text: "original" },
    ]);
    await importer.import(session.id, "import_1");
    vi.mocked(runner.loadSessionHistory).mockResolvedValue([
      { kind: "message", text: "rewritten" },
    ]);

    await expect(importer.preview(session.id)).rejects.toThrow(
      "provider_history_prefix_changed",
    );
    catalog.close();
    store.close();
  });
});
