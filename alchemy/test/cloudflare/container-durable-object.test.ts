import { mkdtemp, rm } from "node:fs/promises";
import path from "pathe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Context } from "../../src/context.ts";
import type { CloudflareApi } from "../../src/cloudflare/api.ts";
import {
  assertNoContainerSchedulingPolicyFlip,
  Container,
  type ContainerProps,
  isDurableObjectContainer,
  prepareContainerImage,
  reconcileDurableObjectContainerApplication,
  validateContainerImageReference,
} from "../../src/cloudflare/container.ts";
import { buildWorkerOptions } from "../../src/cloudflare/miniflare/build-worker-options.ts";
import { WorkerBundleSource } from "../../src/cloudflare/worker-bundle.ts";
import { prepareWorkerMetadata } from "../../src/cloudflare/worker-metadata.ts";
import { WranglerJson } from "../../src/cloudflare/wrangler.json.ts";
import { Scope } from "../../src/scope.ts";
import type { State, StateStoreType } from "../../src/state.ts";

const mocks = vi.hoisted(() => ({
  accountId: "a".repeat(32),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  image: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  tag: vi.fn(),
}));

vi.mock("../../src/cloudflare/api.ts", () => ({
  createCloudflareApi: async () => mocks,
}));
vi.mock("../../src/docker/image.ts", () => ({ Image: mocks.image }));
vi.mock("../../src/docker/registry.ts", () => ({
  pushImageToRegistry: mocks.push,
}));
vi.mock("../../src/docker/api.ts", () => ({
  DockerApi: class {
    pullImage = mocks.pull;
    tagImage = mocks.tag;
    login = vi.fn();
    logout = vi.fn();
  },
}));

const digest = "b".repeat(64);
const reference = `registry.cloudflare.com/${mocks.accountId}/sandbox@sha256:${digest}`;
const api = mocks as unknown as CloudflareApi;
const envelope = (result: unknown, status = 200) =>
  Response.json({ result, errors: [] }, { status });
const failures = (status: number, message: string, code = 1) =>
  Response.json({ errors: [{ code, message }] }, { status });
const props = {
  className: "Sandbox",
  schedulingPolicy: "durable_object",
  images: { generation: { build: { context: "." }, tag: "v1" } },
} satisfies ContainerProps;
const image = (imageRef = reference) => ({
  kind: "Image" as const,
  name: "sandbox",
  tag: "v1",
  imageRef,
  repoDigest: imageRef,
  builtAt: 1,
  build: undefined,
});

function makeScope(
  local = false,
  state = new Map<string, Map<string, State>>(),
) {
  const stateStore: StateStoreType = (scope) => {
    const key = scope.chain.join("/");
    const items = state.get(key) ?? new Map<string, State>();
    state.set(key, items);
    return {
      list: async () => [...items.keys()],
      count: async () => items.size,
      get: async (id) => items.get(id),
      getBatch: async (ids) =>
        Object.fromEntries(
          ids.filter((id) => items.has(id)).map((id) => [id, items.get(id)!]),
        ),
      all: async () => Object.fromEntries(items),
      set: async (id, value) => {
        items.set(id, value);
      },
      delete: async (id) => {
        items.delete(id);
      },
    };
  };
  const root = new Scope({
    scopeName: "container-offline",
    parent: null,
    stateStore,
    quiet: true,
    noTrack: true,
    local,
    phase: "up",
  });
  return new Scope({ scopeName: "test", parent: root });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCKER_HOST", "unix:///offline-docker.sock");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network access");
    }),
  );
  mocks.get.mockImplementation(async () => failures(404, "Not found"));
  mocks.post.mockImplementation(async (endpoint: string) =>
    endpoint.endsWith("/credentials")
      ? envelope({ username: "test", password: "test" })
      : envelope({ status: "ready" }),
  );
  mocks.image.mockImplementation(async (_id, props) => ({
    ...image(`${props.name}:${props.tag}`),
    name: props.name,
    tag: props.tag,
    build: props.build,
    repoDigest: undefined,
  }));
  mocks.push.mockImplementation(async (ref) => ({
    imageRef: `registry.cloudflare.com/${ref}`,
    repoDigest: `registry.cloudflare.com/${ref.split(":")[0]}@sha256:${digest}`,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.sequential("durable object containers offline", () => {
  test.each([
    "image",
    "build",
    "tag",
    "instanceType",
    "maxInstances",
    "rollout",
    "constraints",
  ])("rejects forbidden %s before building", async (key) => {
    await expect(
      Container("invalid", {
        ...props,
        [key]: "invalid",
      } as unknown as ContainerProps),
    ).rejects.toThrow("start()");
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { "": props.images.generation },
    { ["a".repeat(129)]: props.images.generation },
    Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [
        String(i),
        props.images.generation,
      ]),
    ),
  ])("rejects invalid image keys before building", async (images) => {
    await expect(Container("invalid", { ...props, images })).rejects.toThrow(
      /between 1 and (100|128)/,
    );
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test("accepts 100 keys and 128-character keys, with one shared push and preparation", async () => {
    const container = await makeScope().run(() =>
      Container("sandbox", {
        ...props,
        images: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            i === 0 ? "a".repeat(128) : String(i),
            props.images.generation,
          ]),
        ),
      }),
    );
    expect(Object.keys(container.images)).toHaveLength(100);
    expect(
      new Set(Object.values(container.images).map((image) => image.repoDigest))
        .size,
    ).toBe(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(
      mocks.post.mock.calls.filter(([endpoint]) =>
        endpoint.endsWith("image-preparations"),
      ),
    ).toHaveLength(1);
    expect(container).not.toHaveProperty("image");
    expect(isDurableObjectContainer(container)).toBe(true);
  });

  test("retains preparation with the cached push across runs", async () => {
    const state = new Map<string, Map<string, State>>();
    await makeScope(false, state).run(() => Container("sandbox", props));
    await makeScope(false, state).run(() => Container("sandbox", props));
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(
      mocks.post.mock.calls.filter(([endpoint]) =>
        endpoint.endsWith("image-preparations"),
      ),
    ).toHaveLength(1);
  });

  test("builds distinct keys with their names and tags for linux/amd64", async () => {
    await makeScope().run(() =>
      Container("sandbox", {
        ...props,
        name: "named",
        images: {
          generation: props.images.generation,
          publisher: {
            build: { context: ".", dockerfile: "Otherfile" },
            tag: "v2",
          },
        },
      }),
    );
    expect(
      mocks.image.mock.calls.map(([, input]) => ({
        name: input.name,
        tag: input.tag,
        platform: input.build.platform,
      })),
    ).toEqual([
      {
        name: `${mocks.accountId}/named-generation`,
        tag: "v1",
        platform: "linux/amd64",
      },
      {
        name: `${mocks.accountId}/named-publisher`,
        tag: "v2",
        platform: "linux/amd64",
      },
    ]);
  });

  test("rejects a push without a digest before preparing", async () => {
    mocks.push.mockResolvedValueOnce({ imageRef: "image:v1" });
    await expect(
      makeScope().run(() => Container("sandbox", props)),
    ).rejects.toThrow("without a sha256 digest");
    expect(
      mocks.post.mock.calls.filter(([endpoint]) =>
        endpoint.endsWith("image-preparations"),
      ),
    ).toHaveLength(0);
  });

  test.each([
    "sandbox:latest",
    `registry.cloudflare.com/${"c".repeat(32)}/sandbox@sha256:${digest}`,
    `docker.io/sandbox@sha256:${digest}`,
    `${reference.slice(0, -1)}`,
    `${reference}:tag`,
  ])("rejects invalid registry reference %s", async (ref) => {
    expect(() => validateContainerImageReference(mocks.accountId, ref)).toThrow(
      "digest-pinned",
    );
    await expect(
      makeScope().run(() =>
        Container("sandbox", {
          ...props,
          images: { generation: { image: ref } },
        }),
      ),
    ).rejects.toThrow("digest-pinned");
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test("resolves registry references and prepares duplicates only once without Docker", async () => {
    const container = await makeScope().run(() =>
      Container("sandbox", {
        ...props,
        images: {
          generation: { image: `sandbox@sha256:${digest}` },
          publisher: { image: reference },
          built: { image: { ...image("sandbox:v1"), repoDigest: reference } },
          remote: {
            image: {
              kind: "RemoteImage",
              name: "sandbox",
              imageRef: reference,
              createdAt: 1,
            },
          },
        },
      }),
    );
    expect(container.images.generation.repoDigest).toBe(reference);
    expect(container.images.publisher.repoDigest).toBe(reference);
    expect(container.images.built.repoDigest).toBe(reference);
    expect(container.images.remote.repoDigest).toBe(reference);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      `/accounts/${mocks.accountId}/containers/image-preparations`,
      { image: reference },
    );
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test("dev builds use Miniflare names and skip push and preparation", async () => {
    const container = await makeScope(true).run(() =>
      Container("sandbox", {
        ...props,
        name: "local",
        images: {
          generation: props.images.generation,
          publisher: { build: { context: "." }, tag: "latest" },
        },
      }),
    );
    expect(container.images.generation.imageRef).toBe(
      "cloudflare-dev/local-generation:v1",
    );
    expect(container.images.publisher.imageRef).toMatch(
      /^cloudflare-dev\/local-publisher:latest-\d+$/,
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test("immutable registry images stay prepared across runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = new Map<string, Map<string, State>>();
    const registryProps = {
      ...props,
      images: { generation: { image: reference } },
    };
    await makeScope(false, state).run(() =>
      Container("sandbox", registryProps),
    );
    vi.setSystemTime(Date.now() + 1000);
    await makeScope(false, state).run(() =>
      Container("sandbox", registryProps),
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test("two containers prepare a shared registry digest once", async () => {
    await makeScope().run(() =>
      Promise.all(
        ["first", "second"].map((id) =>
          Container(id, {
            ...props,
            images: { generation: { image: reference } },
          }),
        ),
      ),
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  test("a preparation failure rejects the container before upload", async () => {
    mocks.post.mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );
    await expect(
      makeScope().run(() =>
        Container("sandbox", {
          ...props,
          images: { generation: { image: reference } },
        }),
      ),
    ).rejects.toThrow("image-preparations returned 403");
    expect(mocks.post.mock.calls).toEqual([
      [
        `/accounts/${mocks.accountId}/containers/image-preparations`,
        { image: reference },
      ],
    ]);
  });

  test("undefined and latest build tags share the timestamped default", async () => {
    const container = await makeScope().run(() =>
      Container("sandbox", {
        ...props,
        images: {
          generation: { build: { context: "." } },
          publisher: { build: { context: "." }, tag: "latest" },
        },
      }),
    );
    expect(container.images.generation.tag).toMatch(/^latest-\d+$/);
    expect(container.images.publisher.repoDigest).toBe(
      container.images.generation.repoDigest,
    );
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  test("metadata includes physical name and digests while default metadata is unchanged", async () => {
    const container = await makeScope().run(() =>
      Container("sandbox", {
        ...props,
        images: { generation: { image: reference } },
      }),
    );
    const metadata = await prepareWorkerMetadata(api, {
      workerName: "worker",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      bindings: {
        SANDBOX: container,
        DEFAULT: {
          type: "container",
          id: "default",
          className: "Default",
          image: image(),
          sqlite: true,
        },
      },
    });
    expect(metadata.containers).toEqual([
      {
        name: container.name,
        class_name: "Sandbox",
        images: { generation: reference },
      },
      { class_name: "Default" },
    ]);
    expect(container.name).toBeTruthy();
  });

  test("metadata refuses a missing digest", async () => {
    await expect(
      prepareWorkerMetadata(api, {
        workerName: "worker",
        compatibilityDate: "2026-10-01",
        compatibilityFlags: [],
        bindings: {
          SANDBOX: {
            type: "container",
            id: "sandbox",
            name: "sandbox",
            className: "Sandbox",
            schedulingPolicy: "durable_object",
            images: { generation: { ...image(), repoDigest: undefined } },
          },
        },
      }),
    ).rejects.toThrow("repoDigest");
  });

  test("Miniflare receives named images and retains default imageName", async () => {
    const options = await buildWorkerOptions({
      api,
      id: "worker",
      name: "worker",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      bindings: {
        SANDBOX: {
          type: "container",
          id: "sandbox",
          name: "sandbox",
          className: "Sandbox",
          schedulingPolicy: "durable_object",
          images: {
            generation: image("cloudflare-dev/sandbox-generation:v1"),
            publisher: image("cloudflare-dev/sandbox-publisher:v2"),
          },
          sqlite: true,
        },
        DEFAULT: {
          type: "container",
          id: "default",
          className: "Default",
          image: image("cloudflare-dev/default:v1"),
          sqlite: true,
        },
      },
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
    const generated = await options.watch(new AbortController().signal).next();
    expect(generated.value?.durableObjects).toEqual({
      SANDBOX: {
        className: "Sandbox",
        scriptName: undefined,
        useSQLite: true,
        container: {
          images: [
            {
              name: "generation",
              image: "cloudflare-dev/sandbox-generation:v1",
            },
            { name: "publisher", image: "cloudflare-dev/sandbox-publisher:v2" },
          ],
        },
      },
      DEFAULT: {
        className: "Default",
        scriptName: undefined,
        useSQLite: true,
        container: { imageName: "cloudflare-dev/default:v1" },
      },
    });
  });

  test("Wrangler emits named builds without credentials", async () => {
    const directory = await mkdtemp(
      path.join(process.cwd(), ".container-test-"),
    );
    try {
      const config = await makeScope(true).run(() =>
        WranglerJson({
          path: path.join(directory, "wrangler.json"),
          worker: {
            name: "worker",
            cwd: directory,
            entrypoint: "worker.ts",
            accountId: mocks.accountId,
            bindings: {
              SANDBOX: {
                type: "container",
                id: "sandbox",
                name: "sandbox",
                className: "Sandbox",
                schedulingPolicy: "durable_object",
                images: {
                  generation: {
                    ...image(),
                    build: { context: "source", dockerfile: "Dockerfile.prod" },
                  },
                  publisher: {
                    ...image(),
                    build: { dockerfile: "Dockerfile" },
                  },
                  registry: { ...image("ignored:tag"), repoDigest: reference },
                  short: {
                    ...image(`sandbox@sha256:${digest}`),
                    repoDigest: undefined,
                  },
                },
              },
            },
          },
        }),
      );
      expect(config.spec.containers).toEqual([
        {
          name: "sandbox",
          class_name: "Sandbox",
          scheduling_policy: "durable_object",
          images: {
            generation: {
              dockerfile: path.join(directory, "source/Dockerfile.prod"),
              build_context: path.join(directory, "source"),
            },
            publisher: { dockerfile: path.join(process.cwd(), "Dockerfile") },
            registry: { image: reference },
            short: { image: reference },
          },
        },
      ]);
      expect(mocks.get).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe.sequential("container scheduling policy state guard", () => {
  const previous: Container = {
    type: "container",
    id: "previous",
    name: "previous-sandbox",
    className: "Sandbox",
    schedulingPolicy: "default",
    image: image(),
  };
  const current: Container = {
    type: "container",
    id: "current",
    name: "sandbox",
    className: "Sandbox",
    schedulingPolicy: "durable_object",
    images: { generation: image() },
  };

  afterEach(() => {
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  test("refuses a default to durable_object flip before upload", () => {
    expect(() =>
      assertNoContainerSchedulingPolicyFlip(
        { OLD: previous },
        [current],
        "worker",
      ),
    ).toThrow(
      'Container application for class "Sandbox" uses the default policy. The switch to durable_object is one-way and is not done in place. It was refused before the Worker upload, so the live Worker is unchanged. Add a new Durable Object class (new className, new container name) next to the old one.',
    );
  });

  test("treats an undefined previous policy as default", () => {
    expect(() =>
      assertNoContainerSchedulingPolicyFlip(
        { OLD: { ...previous, schedulingPolicy: undefined } },
        [{ ...current, scriptName: "worker" }],
        "worker",
      ),
    ).toThrow("uses the default policy");
  });

  test("allows durable_object to durable_object", () => {
    expect(() =>
      assertNoContainerSchedulingPolicyFlip(
        { OLD: current },
        [current],
        "worker",
      ),
    ).not.toThrow();
  });

  test("allows a new class next to the old default class", () => {
    expect(() =>
      assertNoContainerSchedulingPolicyFlip(
        { OLD: previous },
        [
          previous,
          { ...current, className: "NextSandbox", name: "next-sandbox" },
        ],
        "worker",
      ),
    ).not.toThrow();
  });

  test("allows a cross-script durable_object container", () => {
    expect(() =>
      assertNoContainerSchedulingPolicyFlip(
        { OLD: previous },
        [{ ...current, scriptName: "other-worker" }],
        "worker",
      ),
    ).not.toThrow();
  });

  test("allows missing previous bindings", () => {
    expect(() =>
      assertNoContainerSchedulingPolicyFlip(undefined, [current], "worker"),
    ).not.toThrow();
  });
});

describe.sequential("container image preparation", () => {
  test("ready succeeds immediately", async () => {
    const wait = vi.fn();
    await expect(
      prepareContainerImage(api, reference, { sleep: wait }),
    ).resolves.toBeUndefined();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
  test("pending is re-posted every two seconds until ready", async () => {
    mocks.post
      .mockResolvedValueOnce(envelope({ status: "pending" }))
      .mockResolvedValueOnce(envelope({ status: "ready" }));
    const wait = vi.fn(async () => {});
    await prepareContainerImage(api, reference, { sleep: wait });
    expect(wait).toHaveBeenCalledWith(2000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls).toEqual(
      Array(2).fill([
        `/accounts/${mocks.accountId}/containers/image-preparations`,
        { image: reference },
      ]),
    );
  });
  test("error includes the preparation reason", async () => {
    mocks.post.mockResolvedValueOnce(
      envelope({ status: "error", reason: "Image architecture unsupported" }),
    );
    await expect(prepareContainerImage(api, reference)).rejects.toThrow(
      "Image architecture unsupported",
    );
  });
  test("pending times out at fifteen minutes", async () => {
    vi.useFakeTimers();
    mocks.post.mockImplementation(async () => envelope({ status: "pending" }));
    const wait = vi.fn(async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    });
    await expect(
      prepareContainerImage(api, reference, { sleep: wait }),
    ).rejects.toThrow("after 900000ms");
    expect(wait).toHaveBeenCalledTimes(450);
    expect(mocks.post).toHaveBeenCalledTimes(450);
  });
  test("accepts injected polling interval and timeout", async () => {
    vi.useFakeTimers();
    mocks.post.mockImplementation(async () => envelope({ status: "pending" }));
    const wait = vi.fn(async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    });
    await expect(
      prepareContainerImage(api, reference, {
        sleep: wait,
        pollIntervalMs: 5,
        timeoutMs: 12,
      }),
    ).rejects.toThrow("after 12ms");
    expect(wait.mock.calls).toEqual([[5], [5], [2]]);
  });
  test("403 names the endpoint and account without requiring a JSON response", async () => {
    mocks.post.mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );
    await expect(prepareContainerImage(api, reference)).rejects.toThrow(
      `account ${mocks.accountId}: POST /accounts/${mocks.accountId}/containers/image-preparations returned 403`,
    );
  });
});

const application = {
  id: "namespace",
  name: "sandbox",
  scheduling_policy: "durable_object",
  durable_objects: { namespace_id: "namespace" },
};

describe.sequential("durable object application lifecycle", () => {
  test("the resource branches before default update and rollout logic", async () => {
    mocks.get.mockResolvedValueOnce(envelope(application));
    const handler = globalThis.ALCHEMY_PROVIDERS.get(
      "cloudflare::ContainerApplication",
    )!.handler;
    const output = await handler.call(
      {
        phase: "update",
        output: { id: "prior", name: "sandbox" },
        scope: makeScope(),
      } as unknown as Context<{ id: string; name: string }>,
      "sandbox",
      {
        name: "sandbox",
        schedulingPolicy: "durable_object",
        durableObjects: { namespaceId: "namespace" },
      },
    );
    expect(output).toEqual({ id: "namespace", name: "sandbox" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      `/accounts/${mocks.accountId}/containers/applications/namespace`,
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  test("creates only the DO-policy body on 404", async () => {
    mocks.post.mockResolvedValueOnce(envelope(application));
    await expect(
      reconcileDurableObjectContainerApplication(api, "sandbox", "namespace", {
        logs: { enabled: true },
      }),
    ).resolves.toEqual({ id: "namespace", name: "sandbox" });
    expect(mocks.get).toHaveBeenCalledWith(
      `/accounts/${mocks.accountId}/containers/applications/namespace`,
    );
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      `/accounts/${mocks.accountId}/containers/applications`,
      {
        name: "sandbox",
        scheduling_policy: "durable_object",
        durable_objects: { namespace_id: "namespace" },
        observability: { logs: { enabled: true } },
      },
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  test("patches only changed observability", async () => {
    mocks.get.mockResolvedValueOnce(
      envelope({ ...application, observability: { logs: { enabled: false } } }),
    );
    mocks.patch.mockResolvedValueOnce(envelope(application));
    await reconcileDurableObjectContainerApplication(
      api,
      "sandbox",
      "namespace",
      { logs: { enabled: true } },
    );
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(
      `/accounts/${mocks.accountId}/containers/applications/namespace`,
      { observability: { logs: { enabled: true } } },
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  test("leaves unchanged observability alone", async () => {
    mocks.get.mockResolvedValueOnce(
      envelope({ ...application, observability: { logs: { enabled: true } } }),
    );
    await reconcileDurableObjectContainerApplication(
      api,
      "sandbox",
      "namespace",
      { logs: { enabled: true } },
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  test.each([
    { scheduling_policy: "default" },
    { id: "different" },
    { durable_objects: { namespace_id: "different" } },
    { name: "different" },
  ])(
    "refuses mismatched application without deleting: %j",
    async (mismatch) => {
      mocks.get.mockResolvedValueOnce(
        envelope({ ...application, ...mismatch }),
      );
      await expect(
        reconcileDurableObjectContainerApplication(api, "sandbox", "namespace"),
      ).rejects.toThrow(
        "scheduling_policy" in mismatch
          ? /one-way.*new Durable Object class/
          : "Cannot adopt",
      );
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    },
  );
  test.each([
    { ...application, id: "old-app", scheduling_policy: "default" },
    { ...application, id: "other", durable_objects: { namespace_id: "other" } },
  ])("refuses creation conflicts without deleting: %j", async (existing) => {
    mocks.get
      .mockResolvedValueOnce(failures(404, "Not found"))
      .mockResolvedValueOnce(envelope([existing]));
    mocks.post.mockResolvedValueOnce(failures(409, "already exists", 1608));
    await expect(
      reconcileDurableObjectContainerApplication(api, "sandbox", "namespace"),
    ).rejects.toThrow(
      existing.scheduling_policy === "default"
        ? /one-way.*new Durable Object class/
        : "Cannot adopt",
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  test("GET failure does not attempt creation", async () => {
    mocks.get.mockResolvedValueOnce(failures(403, "Forbidden"));
    await expect(
      reconcileDurableObjectContainerApplication(api, "sandbox", "namespace"),
    ).rejects.toThrow("Forbidden");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  test("delete removes only the resource output id", async () => {
    mocks.delete.mockResolvedValueOnce(envelope({}));
    const destroy = vi.fn();
    const handler = globalThis.ALCHEMY_PROVIDERS.get(
      "cloudflare::ContainerApplication",
    )!.handler;
    await handler.call(
      {
        phase: "delete",
        output: { id: "owned", name: "sandbox" },
        scope: makeScope(),
        destroy,
      } as unknown as Context<{ id: string; name: string }>,
      "sandbox",
      {
        name: "sandbox",
        schedulingPolicy: "durable_object",
        durableObjects: { namespaceId: "namespace" },
      },
    );
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith(
      `/accounts/${mocks.accountId}/containers/applications/owned`,
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
