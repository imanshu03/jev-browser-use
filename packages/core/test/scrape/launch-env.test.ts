import { afterEach, expect, it, vi } from "vitest";
import { fakeHuman, fakeLogger } from "../fakes.js";

const configs = vi.hoisted(() => [] as { apiKey?: string; baseURL?: string }[]);
vi.mock("@typesafe-ai/sdk", async (load) => {
  const sdk = await load<typeof import("@typesafe-ai/sdk")>();
  return { ...sdk, TypeSafeClient: class extends sdk.TypeSafeClient {
    constructor(config: ConstructorParameters<typeof sdk.TypeSafeClient>[0]) {
      configs.push(config ?? {});
      super(config);
    }
  } };
});
vi.mock("../../src/transport.js", () => ({ createTransport: () => ({ fetch, warm: async () => undefined, close: async () => undefined }) }));

const { lazyNavigator, navBase } = await import("../../src/scrape/launch.js");
afterEach(() => { vi.unstubAllEnvs(); configs.length = 0; });

it("uses the supplied key and API URL without changing the process environment", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const env = { TYPESAFE_API_KEY: "configured-key", TYPESAFE_BASE_URL: "http://127.0.0.1:12345" };
  const log = fakeLogger();
  const nav = lazyNavigator(env, log, fakeHuman({ interactive: false }), [], navBase(env, { headed: false }));
  try {
    await nav.navigator?.warm?.();
    expect(configs[0]).toMatchObject({ apiKey: "configured-key", baseURL: "http://127.0.0.1:12345" });
    expect(process.env["TYPESAFE_API_KEY"]).toBe("");
  } finally { await nav.close(); }
});
