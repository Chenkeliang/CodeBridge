import { describe, expect, it } from "vitest";
import {
  runnerAppInfo,
  runnerInfoPlist,
} from "./install-macos-runner-app.mjs";

describe("macOS Runner app identity", () => {
  it("uses one stable bundle id and executable path", () => {
    expect(runnerAppInfo("/Users/tester")).toEqual({
      bundleId: "com.feishu-code-bridge.runner",
      appPath: "/Users/tester/Applications/Feishu Code Runner.app",
      executablePath:
        "/Users/tester/Applications/Feishu Code Runner.app/Contents/MacOS/FeishuCodeRunner",
    });
  });

  it("declares protected-folder usage descriptions for the TCC prompt", () => {
    const plist = runnerInfoPlist();
    expect(plist).toContain("NSDesktopFolderUsageDescription");
    expect(plist).toContain("NSDocumentsFolderUsageDescription");
    expect(plist).toContain("NSDownloadsFolderUsageDescription");
  });
});
