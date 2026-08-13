import { describe, expect, it, vi } from "vitest";
import viteConfig, { pythonWorkerSecurityHeaders } from "../../vite.config.js";
import {
  PYTHON_RUNNER_WORKER_URL,
  PYTHON_TERMINAL_WORKER_URL,
  PYTHON_WORKER_DEVELOPMENT_CONTENT_SECURITY_POLICY,
} from "../pythonRunnerContract.js";

describe("Vite Python worker security headers", () => {
  it("fails fast instead of moving to an Origin the API does not allow", () => {
    expect(viteConfig.server).toMatchObject({
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    });
  });

  it("sets the network-denying development CSP only on Python workers", () => {
    let middleware:
      | ((
          req: { url?: string },
          res: { setHeader(name: string, value: string): void },
          next: () => void,
        ) => void)
      | undefined;
    const plugin = pythonWorkerSecurityHeaders();
    const hook = plugin.configureServer;
    if (typeof hook !== "function") throw new Error("Missing Vite server hook");
    hook.call({} as never, {
      middlewares: {
        use(next: typeof middleware) {
          middleware = next;
        },
      },
    } as never);
    if (!middleware) throw new Error("Python worker middleware was not installed");

    for (const url of [PYTHON_RUNNER_WORKER_URL, PYTHON_TERMINAL_WORKER_URL]) {
      const setHeader = vi.fn();
      const next = vi.fn();
      middleware({ url }, { setHeader }, next);
      expect(setHeader).toHaveBeenCalledWith(
        "Content-Security-Policy",
        PYTHON_WORKER_DEVELOPMENT_CONTENT_SECURITY_POLICY,
      );
      expect(next).toHaveBeenCalledOnce();
    }

    const ordinaryHeader = vi.fn();
    middleware({ url: "/src/main.tsx" }, { setHeader: ordinaryHeader }, vi.fn());
    expect(ordinaryHeader).not.toHaveBeenCalled();
  });
});
