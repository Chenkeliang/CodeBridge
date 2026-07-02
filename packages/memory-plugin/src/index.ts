/**
 * Optional long-term memory plugin (Phase 4).
 * Disabled by default via config.plugins.memory.enabled
 */
export interface MemoryPluginOptions {
  enabled: boolean;
  workspaceDir: string;
}

export class MemoryPlugin {
  constructor(private readonly options: MemoryPluginOptions) {}

  isEnabled(): boolean {
    return this.options.enabled;
  }

  async search(_query: string): Promise<string[]> {
    if (!this.options.enabled) return [];
    return [];
  }

  async write(_note: string): Promise<void> {
    if (!this.options.enabled) return;
  }
}

export function createMemoryPlugin(
  options: MemoryPluginOptions,
): MemoryPlugin {
  return new MemoryPlugin(options);
}
