import type { Hono } from "hono";

// A transport header or shared Agent bearer cannot manufacture an in-process adapter origin.
const nativeRequests = new WeakSet<Request>();
export function isNativeChannelRequest(request: Request): boolean {
  return nativeRequests.has(request);
}
export function channelRequest(app: Hono, path: string, init: RequestInit): Promise<Response> {
  const request = new Request(new URL(path, "http://channel.internal"), init);
  nativeRequests.add(request);
  return Promise.resolve(app.fetch(request));
}
