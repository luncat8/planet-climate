/* probe_webgpu.js — Phase-5 readiness check: can THIS browser run WebGPU?
 *
 *   node harness/probe_webgpu.js            (headless sandbox Chromium)
 *
 * Reports navigator.gpu availability, adapter info, and runs a tiny compute
 * dispatch end-to-end. Phase 5 (WebGPU port, P5.1–P5.6) needs this to pass
 * on the machine that will develop/verify the engine — the sandbox result is
 * recorded below; re-run there before starting P5 work.
 *
 * SANDBOX RESULT (2026-09-12, Chromium 152.0.7977.0 headless,
 * @sparticuz/chromium build, --enable-unsafe-swiftshader set via
 * chrome-launch.js): navigator.gpu is UNDEFINED, also with
 * --enable-features=WebGPU,... — this build ships no WebGPU implementation.
 * Consequence: P5 parity/perf harnesses must run on an owner browser with
 * WebGPU; the WebGL engine + bench_backend.js remain the sandbox-verifiable
 * surface until then.
 */
const puppeteer = require('puppeteer');
const { launchBrowser } = require('./chrome-launch');
(async () => {
  const b = await launchBrowser(puppeteer, {
    args: ['--enable-features=Vulkan', '--no-sandbox'],
  });
  const page = await b.newPage();
  const out = await page.evaluate(async () => {
    const r = { gpu: !!navigator.gpu, adapter: null, device: null, compute: null, err: null };
    try {
      if (!navigator.gpu) return r;
      const a = await navigator.gpu.requestAdapter();
      if (!a) { r.err = 'no adapter'; return r; }
      r.adapter = {
        isFallback: a.isFallbackAdapter,
        features: [...a.features].slice(0, 12),
        limits: { maxComputeWorkgroupSizeX: a.limits.maxComputeWorkgroupSizeX,
                  maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize },
      };
      const d = await a.requestDevice();
      r.device = true;
      // Tiny compute sanity check: double 8 floats.
      const wgsl = '@group(0) @binding(0) var<storage, read_write> b: array<f32, 8>;\n' +
                   '@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) g: vec3u) { b[g.x] = b[g.x] * 2.0; }';
      const mod = d.createShaderModule({ code: wgsl });
      const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const buf = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const staging = d.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const q = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: buf } }] });
      const init = d.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Float32Array(init.getMappedRange()).set([1, 2, 3, 4, 5, 6, 7, 8]);
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(init, 0, buf, 0, 32);
      const pass = enc.beginComputePass();
      pass.setPipeline(d.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } }));
      pass.setBindGroup(0, q);
      pass.dispatchWorkgroups(1);
      pass.end();
      enc.copyBufferToBuffer(buf, 0, staging, 0, 32);
      d.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      r.compute = Array.from(new Float32Array(staging.getMappedRange()));
    } catch (e) { r.err = String(e); }
    return r;
  });
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})();
