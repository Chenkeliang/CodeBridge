import { describe, expect, it } from "vitest";
import {
  fileAttachmentPromptSuffix,
  isImageMime,
  partitionAttachments,
} from "./attachment-prompt.js";

describe("attachment-prompt", () => {
  it("treats image/* as images and everything else as files", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
    const { images, files } = partitionAttachments([
      { path: "/tmp/a.png", mimeType: "image/png", name: "a.png" },
      {
        path: "/tmp/b.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        name: "b.xlsx",
      },
    ]);
    expect(images.map((item) => item.name)).toEqual(["a.png"]);
    expect(files.map((item) => item.name)).toEqual(["b.xlsx"]);
  });

  it("appends absolute file paths for the agent to Read", () => {
    expect(fileAttachmentPromptSuffix([])).toBe("");
    expect(
      fileAttachmentPromptSuffix([
        {
          path: "/data/attachments/run-1/订单.csv",
          mimeType: "text/csv",
          name: "订单.csv",
        },
      ]),
    ).toBe(
      "\n\n【用户附件已保存到本地，请用 Read 等工具打开该路径】\n" +
        "- 订单.csv (text/csv): /data/attachments/run-1/订单.csv",
    );
  });
});
