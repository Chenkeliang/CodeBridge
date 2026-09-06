import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from "@larksuiteoapi/node-sdk";

/** Bound CardKit I/O while preserving the SDK's auth/response interceptors. */
export function feishuHttpClient(base: HttpInstance = defaultHttpInstance): HttpInstance {
  function request<T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
    const cardkit = options.url?.includes("/open-apis/cardkit/");
    return base.request<T, R, D>({
      ...options,
      ...(cardkit ? { timeout: options.timeout && options.timeout > 0 ? Math.min(options.timeout, 15_000) : 15_000 } : {}),
    });
  }
  return {
    request,
    get: (url, opts) => request({ ...opts, method: "GET", url }),
    delete: (url, opts) => request({ ...opts, method: "DELETE", url }),
    head: (url, opts) => request({ ...opts, method: "HEAD", url }),
    options: (url, opts) => request({ ...opts, method: "OPTIONS", url }),
    post: (url, data, opts) => request({ ...opts, method: "POST", url, data }),
    put: (url, data, opts) => request({ ...opts, method: "PUT", url, data }),
    patch: (url, data, opts) => request({ ...opts, method: "PATCH", url, data }),
  };
}
