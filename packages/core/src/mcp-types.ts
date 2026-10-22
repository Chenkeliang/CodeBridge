export interface StdioMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
