export interface ParsedSseFrames<T> {
  events: T[];
  remainder: string;
}

export function parseSseFrames<T = unknown>(source: string): ParsedSseFrames<T> {
  const frames = source.split("\n\n");
  const remainder = frames.pop() ?? "";
  const events: T[] = [];
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) events.push(JSON.parse(data) as T);
  }
  return { events, remainder };
}
