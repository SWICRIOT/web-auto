// One-shot probe: does launchBrowser now get hardware WebGL? Prints the unmasked renderer
// and a rough render-loop throughput on the live insert-creator preview.
import { launchBrowser } from "./browser";

(async () => {
  const { page, cleanup } = await launchBrowser({ headless: false });
  const info = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { renderer: "no webgl" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
  console.log("RENDERER:", info.renderer);
  await page.goto("https://insert-creator-rust.alexander-lind.workers.dev/");
  await page.waitForTimeout(4000); // load + first preview
  const fps = await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
          else res(Math.round((n * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      })
  );
  console.log("rAF ticks/s on the live app:", fps);
  await cleanup();
})();
