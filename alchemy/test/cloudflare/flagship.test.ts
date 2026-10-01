import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CloudflareApi } from "../../src/cloudflare/api.ts";
import type { Bindings } from "../../src/cloudflare/bindings.ts";
import { DurableObjectNamespace } from "../../src/cloudflare/durable-object-namespace.ts";
import { Flagship } from "../../src/cloudflare/flagship.ts";
import { buildWorkerOptions } from "../../src/cloudflare/miniflare/build-worker-options.ts";
import { WorkerBundleSource } from "../../src/cloudflare/worker-bundle.ts";
import { prepareWorkerMetadata } from "../../src/cloudflare/worker-metadata.ts";

const mocks = vi.hoisted(() => ({ accountId: "a".repeat(32), get: vi.fn() }));
vi.mock("../../src/cloudflare/api.ts", () => ({
  createCloudflareApi: async () => mocks,
}));
const api = mocks as unknown as CloudflareApi;
const metadataProps = {
  workerName: "worker",
  compatibilityDate: "2026-10-01",
  compatibilityFlags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network access");
    }),
  );
  mocks.get.mockImplementation(async () =>
    Response.json(
      { errors: [{ code: 1, message: "Not found" }] },
      { status: 404 },
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe.sequential("Flagship bindings offline", () => {
  test("rejects an empty app ID", () => {
    expect(() => Flagship("")).toThrow("Flagship appId must not be empty");
  });

  test("uploads exactly one wire-format binding", async () => {
    const metadata = await prepareWorkerMetadata(api, {
      ...metadataProps,
      bindings: { FLAGS: Flagship("app-1") },
    });
    expect(metadata.bindings).toEqual([
      { type: "flagship", name: "FLAGS", app_id: "app-1" },
    ]);
    expect(metadata.migrations?.deleted_classes).toEqual([]);
  });

  test("preserves Durable Object migrations when Flagship is added or removed", async () => {
    const oldBindings = [
      {
        type: "durable_object_namespace",
        name: "ROOMS",
        class_name: "Room",
      },
    ];
    const settings = (withFlagship: boolean) => {
      mocks.get.mockImplementation(async () =>
        Response.json({
          success: true,
          result: {
            tags: ["alchemy:do:rooms:ROOMS", "alchemy:migration-tag:1"],
            bindings: [
              ...oldBindings,
              ...(withFlagship
                ? [
                    {
                      type: "flagship",
                      name: "FLAGS",
                      app_id: "app-1",
                    },
                  ]
                : []),
            ],
          },
          errors: [],
        }),
      );
    };
    const bindings = {
      ROOMS: DurableObjectNamespace("rooms", { className: "Room" }),
      NEW: DurableObjectNamespace("new", {
        className: "NewRoom",
        sqlite: true,
      }),
    };
    settings(false);
    const baseline = await prepareWorkerMetadata(api, {
      ...metadataProps,
      bindings,
    });
    const added = await prepareWorkerMetadata(api, {
      ...metadataProps,
      bindings: { ...bindings, FLAGS: Flagship("app-1") },
    });
    settings(true);
    const removed = await prepareWorkerMetadata(api, {
      ...metadataProps,
      bindings,
    });
    expect(baseline.migrations?.new_sqlite_classes).toEqual(["NewRoom"]);
    expect(baseline.migrations?.deleted_classes).toEqual([]);
    expect(added.migrations).toEqual(baseline.migrations);
    expect(removed.migrations).toEqual(baseline.migrations);
  });

  test("leaves local Miniflare options unchanged", async () => {
    const generate = async (bindings: Bindings) => {
      const options = await buildWorkerOptions({
        api,
        id: "worker",
        name: "worker",
        compatibilityDate: "2026-10-01",
        compatibilityFlags: [],
        bindings,
        eventSources: undefined,
        assets: undefined,
        bundle: new WorkerBundleSource.Inline({
          content: "export default {}",
          format: "esm",
          nodeCompat: null,
        }),
        port: 8787,
        tunnel: false,
        cwd: process.cwd(),
      });
      expect(options.remoteProxy).toBeUndefined();
      const watch = options.watch(new AbortController().signal);
      try {
        return (await watch.next()).value;
      } finally {
        await watch.return();
      }
    };
    expect(await generate({ FLAGS: Flagship("app-1") })).toEqual(
      await generate({}),
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
