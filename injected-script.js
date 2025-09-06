const API_CONFIG = {
  version: "vip_protocol_v6",
  endpoints: [
    // "/api/goods/list",
    // "/api/promotion/data",
    // "/api/analytics",
    "/api/v4/pdp/get_pc",
  ],
};
console.log("API_CONFIG", API_CONFIG);
function extractUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  try {
    // 兼容 URL 对象
    if (input instanceof URL) return input.toString();
  } catch {}
  return "";
}

const createFetchProxy = (originalFetch) => {
  return async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = extractUrl(args[0]) || "";
      if (url && API_CONFIG.endpoints.some((ep) => url.includes(ep))) {
        const cloned = response.clone();

        // 仅尝试在 JSON Content-Type 时解析，避免抛错
        const ct = cloned.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const data = await cloned.json();
          console.log("data", data);
          window.postMessage(
            {
              type: "API_MONITOR",
              url,
              payload: data,
            },
            "*"
          );
        }
      }
    } catch (err) {
      // 保护性捕获，不影响原始响应返回
      // console.warn("[fetch-proxy] monitor error:", err);
    }

    return response;
  };
};

if (typeof window !== "undefined" && window.fetch) {
  window.fetch = createFetchProxy(window.fetch);
}
