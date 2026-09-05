import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  Container,
  ContainerApplication,
} from "../../src/cloudflare/container.ts";
import { FileSystemStateStore } from "../../src/state/file-system-state-store.ts";
import { Scope } from "../../src/scope.ts";

const fake = vi.hoisted(() => ({
  local: new Set<string>(),
  builds: 0,
  pushes: 0,
  rollouts: 0,
  credentials: 0,
  failPush: false,
}));
vi.mock("../../src/docker/api.ts", () => ({
  DockerApi: class {
    async login() {}
    async logout() {}
    async exec(args: string[]) {
      if (args[0] === "build") {
        fake.builds++;
        fake.local.add(args[args.indexOf("-t") + 1]);
      } else if (args[0] === "tag") {
        if (!fake.local.has(args[1])) throw new Error("local image missing");
        fake.local.add(args[2]);
      } else if (args[0] === "push") {
        if (!fake.local.has(args[1])) throw new Error("local image missing");
        fake.pushes++;
        if (fake.failPush) throw new Error("push failed");
      }
      return {
        stdout: `digest: sha256:${String(fake.builds).padStart(64, "0")}`,
        stderr: "",
      };
    }
  },
}));
vi.mock("../../src/cloudflare/api.ts", () => ({
  createCloudflareApi: async () => ({
    accountId: "test-account",
    post: async (path: string, body: object) => {
      if (path.endsWith("/credentials")) {
        fake.credentials++;
        return Response.json({
          result: { username: "test", password: "test" },
        });
      }
      if (path.endsWith("/rollouts")) fake.rollouts++;
      return Response.json({ result: { id: "app-id", name: "app", ...body } });
    },
    patch: async (_path: string, body: object) =>
      Response.json({ result: { id: "app-id", name: "app", ...body } }),
  }),
}));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alchemy-image-cache-"));
  await mkdir(join(root, "context"));
  await writeFile(join(root, "context", "Dockerfile"), "FROM scratch\n");
  Object.assign(fake, {
    builds: 0,
    pushes: 0,
    rollouts: 0,
    credentials: 0,
    failPush: false,
  });
  fake.local.clear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function deploy(
  tag = "inputs-a",
  force = false,
  instanceType: "standard-1" | "standard-2" = "standard-1",
) {
  const scope = new Scope({
    scopeName: "cache-test",
    parent: null,
    stage: "test",
    phase: "up",
    quiet: true,
    noTrack: true,
    force,
    stateStore: (scope) =>
      new FileSystemStateStore(scope, { rootDir: join(root, "state") }),
  });
  return scope.run(async () => {
    const container = await Container("sandbox", {
      tag,
      className: "Sandbox",
      instanceType,
      build: { context: join(root, "context"), dockerfile: "Dockerfile" },
    });
    await ContainerApplication("app", { image: container.image, instanceType });
    await scope.finalize();
    return container.image;
  });
}

describe.sequential("remote container image cache", () => {
  test("reuses the pushed image on a fresh runner without Docker, credentials or rollout", async () => {
    const image = await deploy();
    fake.local.clear();
    expect(await deploy()).toMatchObject({
      imageRef: image.imageRef,
      repoDigest: image.repoDigest,
    });
    expect([fake.builds, fake.pushes, fake.credentials, fake.rollouts]).toEqual(
      [1, 1, 1, 0],
    );
  });
  test("changed inputs rebuild and roll out; compute-only changes reuse the image", async () => {
    await deploy();
    fake.local.clear();
    await deploy("inputs-b");
    expect([fake.builds, fake.pushes, fake.rollouts]).toEqual([2, 2, 1]);
    fake.local.clear();
    await deploy("inputs-b", false, "standard-2");
    expect([fake.builds, fake.pushes, fake.rollouts]).toEqual([2, 2, 2]);
  });
  test("a failed push retries the build on a fresh runner", async () => {
    fake.failPush = true;
    await expect(deploy()).rejects.toThrow("push failed");
    fake.local.clear();
    fake.failPush = false;
    await deploy();
    expect([fake.builds, fake.pushes]).toEqual([2, 2]);
    fake.local.clear();
    await deploy();
    expect([fake.builds, fake.pushes]).toEqual([2, 2]);
  });
  test("force refresh rebuilds even when inputs are unchanged", async () => {
    await deploy();
    fake.local.clear();
    await deploy("inputs-a", true);
    expect([fake.builds, fake.pushes, fake.rollouts]).toEqual([2, 2, 1]);
  });
});
