import fs from "node:fs";
import path from "node:path";

export class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  read(): T {
    if (!fs.existsSync(this.filePath)) {
      return this.defaultValue();
    }
    const raw = fs.readFileSync(this.filePath, "utf8");
    return JSON.parse(raw) as T;
  }

  write(data: T): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  update(mutator: (current: T) => T): T {
    const next = mutator(this.read());
    this.write(next);
    return next;
  }

  protected defaultValue(): T {
    throw new Error("JsonFileStore requires override of defaultValue()");
  }
}

export class JsonMapStore<V> extends JsonFileStore<Record<string, V>> {
  protected defaultValue(): Record<string, V> {
    return {};
  }
}

export class JsonArrayStore<V> extends JsonFileStore<V[]> {
  protected defaultValue(): V[] {
    return [];
  }
}

export function appendJsonl(filePath: string, record: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
