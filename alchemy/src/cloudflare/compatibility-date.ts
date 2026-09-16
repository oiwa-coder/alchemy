import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const miniflareRequire = createRequire(
  require.resolve("miniflare/package.json"),
);
const workerdVersion: string = miniflareRequire("workerd/package.json").version;
const match = /^\d+\.(\d{4})(\d{2})(\d{2})\./.exec(workerdVersion);
if (!match) {
  throw new Error(
    `Cannot derive a compatibility date from workerd ${workerdVersion}.`,
  );
}

/**
 * The default Cloudflare Workers compatibility date, set based on the current workerd release used by Miniflare.
 */
export const DEFAULT_COMPATIBILITY_DATE = `${match[1]}-${match[2]}-${match[3]}`;
