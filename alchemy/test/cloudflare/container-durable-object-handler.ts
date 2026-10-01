import { DurableObject } from "cloudflare:workers";

export class NamedImageContainer extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const ctx = this.ctx as DurableObjectState & {
      container: Container & {
        images: Record<string, string>;
        start(options: ContainerStartupOptions & { image: string }): void;
      };
    };
    if (!ctx.container.running) {
      ctx.container.start({
        image: ctx.container.images.generation,
        enableInternet: false,
        entrypoint: ["python", "-m", "http.server", "8080"],
      });
    }
    return ctx.container.getTcpPort(8080).fetch(request);
  }
}

export default {
  fetch(
    request: Request,
    env: { MY_CONTAINER: DurableObjectNamespace<NamedImageContainer> },
  ) {
    return env.MY_CONTAINER.get(
      env.MY_CONTAINER.idFromName("named-image"),
    ).fetch(request);
  },
};
