import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTES,
  OutboundPublisherStore,
  PUBLISHERS_FILE,
  addPublisher,
  listPublishers,
  loadOutboundPublishers,
  publishersPath,
  revokePublisher,
} from "./outbound-publishers.js";

const RUNNER_TOKEN = "runner-token-0123456789abcdef";
const directories: string[] = [];

function dataDirWith(content: unknown, mode = 0o600): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-publishers-"));
  directories.push(directory);
  const file = path.join(directory, PUBLISHERS_FILE);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  fs.chmodSync(file, mode);
  return directory;
}

afterEach(() => {
  delete process.env.CODEBRIDGE_PUBLISHER_LOCK_TIMEOUT_MS;
  while (directories.length) {
    fs.rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

const VALID = {
  label: "stock-daily-trade",
  token: "publisher-token-abcdefghijklmnop",
  chatId: "oc_example1",
  topicId: "om_1",
  routes: ["file", "markdown", "mention"] as const,
};

function emptyDataDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-publishers-empty-"));
  directories.push(directory);
  return directory;
}

describe("loadOutboundPublishers", () => {
  it("treats a missing file as no publishers", () => {
    expect(loadOutboundPublishers(emptyDataDir(), RUNNER_TOKEN)).toEqual([]);
  });

  it("loads a valid entry and normalises an empty topicId", () => {
    expect(loadOutboundPublishers(dataDirWith([VALID]), RUNNER_TOKEN))
      .toEqual([{ ...VALID, routes: [...VALID.routes] }]);
    expect(loadOutboundPublishers(dataDirWith([{ ...VALID, topicId: "" }]), RUNNER_TOKEN))
      .toEqual([{ ...VALID, topicId: undefined, routes: [...VALID.routes] }]);
  });

  it("grants only markdown and mention when routes are omitted", () => {
    const { routes: _routes, ...withoutRoutes } = VALID;
    expect(loadOutboundPublishers(dataDirWith([withoutRoutes]), RUNNER_TOKEN)[0]!.routes)
      .toEqual(DEFAULT_ROUTES);
  });

  it("accepts a Telegram chat id", () => {
    const entry = { ...VALID, chatId: "telegram:-42", topicId: undefined };
    expect(loadOutboundPublishers(dataDirWith([entry]), RUNNER_TOKEN))
      .toEqual([{ ...entry, routes: [...entry.routes] }]);
  });

  it.each([
    ["对同组或其他用户可读", [VALID], 0o640],
    ["必须是发布者数组", { ...VALID }, 0o600],
    ["缺少 label", [{ ...VALID, label: "" }], 0o600],
    ["少于 24 位", [{ ...VALID, token: "short" }], 0o600],
    ["不能复用 runner token", [{ ...VALID, token: RUNNER_TOKEN }], 0o600],
    ["的 token 与前面的重复", [VALID, { ...VALID, label: "other" }], 0o600],
    ["不是有效的通道聊天 ID", [{ ...VALID, chatId: "ou_person" }], 0o600],
    ["的 topicId 必须是字符串", [{ ...VALID, topicId: 1 }], 0o600],
    ["的 routes 必须是非空数组", [{ ...VALID, routes: [] }], 0o600],
    ["的 routes 含未知路由", [{ ...VALID, routes: ["sms"] }], 0o600],
  ])("rejects %s", (reason, content, mode) => {
    expect(() => loadOutboundPublishers(dataDirWith(content, mode), RUNNER_TOKEN)).toThrow(reason as string);
  });
});

describe("publisher administration", () => {
  it("issues a private credential, rotates by label and keeps the others", () => {
    const directory = emptyDataDir();
    const first = addPublisher(directory, RUNNER_TOKEN, { label: "stock", chatId: "oc_a", topicId: "om_a" });
    const other = addPublisher(directory, RUNNER_TOKEN, { label: "backup", chatId: "telegram:-9" });

    expect(first.token).toHaveLength(48);
    expect(first.routes).toEqual(DEFAULT_ROUTES);
    expect(fs.statSync(publishersPath(directory)).mode & 0o777).toBe(0o600);

    const rotated = addPublisher(directory, RUNNER_TOKEN, {
      label: "stock", chatId: "oc_a", routes: ["file", "markdown"],
    });
    expect(rotated.token).not.toBe(first.token);

    const saved = loadOutboundPublishers(directory, RUNNER_TOKEN);
    expect(saved.map((row) => row.label)).toEqual(["backup", "stock"]);
    expect(saved.find((row) => row.label === "backup")!.token).toBe(other.token);
    expect(saved.find((row) => row.label === "stock")!.routes).toEqual(["file", "markdown"]);
  });

  it("never lists the token itself", () => {
    const directory = emptyDataDir();
    addPublisher(directory, RUNNER_TOKEN, { label: "stock", chatId: "oc_a" });
    const listed = listPublishers(directory, RUNNER_TOKEN);
    expect(listed).toEqual([{ label: "stock", chatId: "oc_a", topicId: undefined, routes: DEFAULT_ROUTES }]);
    expect(JSON.stringify(listed)).not.toContain("token");
  });

  it("rejects an invalid recipient or route before writing anything", () => {
    const directory = emptyDataDir();
    expect(() => addPublisher(directory, RUNNER_TOKEN, { label: "x", chatId: "ou_person" })).toThrow("chatId");
    expect(() => addPublisher(directory, RUNNER_TOKEN, {
      label: "x", chatId: "oc_a", routes: ["sms" as never],
    })).toThrow("未知路由");
    expect(fs.existsSync(publishersPath(directory))).toBe(false);
  });

  it("serialises issuing so a concurrent writer cannot drop a credential", () => {
    const directory = emptyDataDir();
    addPublisher(directory, RUNNER_TOKEN, { label: "seed", chatId: "oc_seed" });
    const lock = `${publishersPath(directory)}.lock`;
    process.env.CODEBRIDGE_PUBLISHER_LOCK_TIMEOUT_MS = "100";

    // 另一个进程正握着锁：这一次签发必须等待并最终报错，而不是直接覆盖它的结果。
    fs.writeFileSync(lock, "", { mode: 0o600 });
    expect(() => addPublisher(directory, RUNNER_TOKEN, { label: "racer", chatId: "oc_racer" }))
      .toThrow("正被另一个进程占用");
    expect(() => revokePublisher(directory, RUNNER_TOKEN, "seed")).toThrow("正被另一个进程占用");
    expect(loadOutboundPublishers(directory, RUNNER_TOKEN).map((row) => row.label)).toEqual(["seed"]);

    // 崩溃留下的陈旧锁不能把后续签发永久卡死。
    const stale = Date.now() - 120_000;
    fs.utimesSync(lock, stale / 1000, stale / 1000);
    expect(addPublisher(directory, RUNNER_TOKEN, { label: "racer", chatId: "oc_racer" }).label).toBe("racer");
    expect(loadOutboundPublishers(directory, RUNNER_TOKEN).map((row) => row.label)).toEqual(["seed", "racer"]);
  });

  it("leaves no lock or temporary file behind", () => {
    const directory = emptyDataDir();
    addPublisher(directory, RUNNER_TOKEN, { label: "seed", chatId: "oc_seed" });
    revokePublisher(directory, RUNNER_TOKEN, "seed");
    expect(fs.readdirSync(directory)).toEqual([PUBLISHERS_FILE]);
  });

  it("reports whether a revoke removed anything", () => {
    const directory = emptyDataDir();
    addPublisher(directory, RUNNER_TOKEN, { label: "stock", chatId: "oc_a" });
    expect(revokePublisher(directory, RUNNER_TOKEN, "absent")).toBe(false);
    expect(revokePublisher(directory, RUNNER_TOKEN, "stock")).toBe(true);
    expect(loadOutboundPublishers(directory, RUNNER_TOKEN)).toEqual([]);
  });
});

describe("OutboundPublisherStore", () => {
  it("picks up a newly issued credential without a restart", () => {
    const directory = emptyDataDir();
    const store = new OutboundPublisherStore(directory, RUNNER_TOKEN);
    expect(store.current()).toEqual([]);

    const issued = addPublisher(directory, RUNNER_TOKEN, { label: "stock", chatId: "oc_a" });
    expect(store.current().map((row) => row.token)).toEqual([issued.token]);

    revokePublisher(directory, RUNNER_TOKEN, "stock");
    expect(store.current()).toEqual([]);
  });

  it("keeps the last good set and reports once when the file turns invalid", () => {
    const directory = emptyDataDir();
    const issued = addPublisher(directory, RUNNER_TOKEN, { label: "stock", chatId: "oc_a" });
    const errors: string[] = [];
    const store = new OutboundPublisherStore(directory, RUNNER_TOKEN, (error) => errors.push(error.message));
    expect(store.current()).toHaveLength(1);

    fs.writeFileSync(publishersPath(directory), "{ not json", { mode: 0o600 });
    expect(store.current().map((row) => row.token)).toEqual([issued.token]);
    expect(store.current().map((row) => row.token)).toEqual([issued.token]);
    expect(errors).toHaveLength(1);
  });
});
