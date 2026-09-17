import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOutboundPublishers, PUBLISHERS_FILE } from "./outbound-publishers.js";

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
  while (directories.length) {
    fs.rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

const VALID = {
  label: "stock-daily-trade",
  token: "publisher-token-abcdefghijklmnop",
  chatId: "oc_625b1a8f",
  topicId: "om_1",
};

describe("loadOutboundPublishers", () => {
  it("treats a missing file as no publishers", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-publishers-none-"));
    directories.push(directory);
    expect(loadOutboundPublishers(directory, RUNNER_TOKEN)).toEqual([]);
  });

  it("loads a valid entry and normalises an empty topicId", () => {
    expect(loadOutboundPublishers(dataDirWith([VALID]), RUNNER_TOKEN)).toEqual([VALID]);
    expect(loadOutboundPublishers(dataDirWith([{ ...VALID, topicId: "" }]), RUNNER_TOKEN))
      .toEqual([{ ...VALID, topicId: undefined }]);
  });

  it("accepts a Telegram chat id", () => {
    const entry = { ...VALID, chatId: "telegram:-42", topicId: undefined };
    expect(loadOutboundPublishers(dataDirWith([entry]), RUNNER_TOKEN)).toEqual([entry]);
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
  ])("rejects %s", (reason, content, mode) => {
    expect(() => loadOutboundPublishers(dataDirWith(content, mode), RUNNER_TOKEN)).toThrow(reason as string);
  });
});
