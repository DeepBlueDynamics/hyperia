# Hyperia GPU Acceleration

## Current State

Hyper 3 uses xterm.js with `@xterm/addon-webgl` (WebGL2). Text cells are
rendered as textured quads on the GPU — glyph atlas uploaded to VRAM, each
cell drawn in a single pass. This is already fast for normal terminal use.

The goal: push beyond what stock Hyper does, especially for our additions
(inline images, spectrogram, browser panes, notification effects).

---

## Layer 1: Electron GPU Flags (5 min)

Chromium respects GPU flags. Add to Electron main process startup:

    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
    app.commandLine.appendSwitch('ignore-gpu-blocklist');

`enable-zero-copy` avoids CPU-side copies when uploading textures.
`ignore-gpu-blocklist` forces GPU path even on drivers Chromium blacklists.

Add to app/index.ts or wherever Electron app is initialized.

---

## Layer 2: Verify WebGL is Active (10 min)

Hyper has `webGLRenderer` in config but silently falls back to canvas if
the WebGL2 context fails. Make it explicit:

    const webgl = new WebglAddon();
    webgl.onContextLost(e => {
      console.warn('WebGL context lost, falling back to canvas');
      webgl.dispose();
    });
    terminal.loadAddon(webgl);

Log to sidecar so we know in /api/logs if GPU is actually being used.

---

## Layer 3: OffscreenCanvas + Worker Thread (1-2 days)

Move the terminal renderer off the main thread entirely:

    +-----------+       +-------------------+
    | Main      |       | Render Worker     |
    | Thread    | ----> | (OffscreenCanvas) |
    |           |       |                   |
    | xterm.js  | post  | WebGL2 draw calls |
    | parser +  | Msg   | glyph atlas       |
    | buffer    |       | cell grid         |
    +-----------+       +-------------------+
         |                      |
         v                      v
    UI events              Composited
    (input, resize)        frame

How:
    const offscreen = termCanvas.transferControlToOffscreen();
    renderWorker.postMessage({ canvas: offscreen }, [offscreen]);

Parser output (dirty cells, cursor position) gets posted to the worker.
GPU draws happen off-thread. Main thread stays responsive for input.

Electron supports OffscreenCanvas today. The xterm.js WebGL addon would
need a thin wrapper to accept an OffscreenCanvas, or we write a custom
renderer that does.

---

## Layer 4: WebGPU Custom Renderer (1-2 weeks)

Electron 28+ ships WebGPU. A custom xterm.js renderer addon using WebGPU
compute shaders for:

  - Glyph rasterization on GPU (skip CPU font shaping for ASCII)
  - Parallel search highlighting (regex across all visible cells)
  - Sixel/image compositing (GPU texture blit, no DOM overlays)
  - Notification ring effects (GPU-accelerated glow/pulse animations)

Architecture:

    +--------------------------------------+
    | xterm.js core (parser, buffer)       |
    +--------------------------------------+
    | Custom WebGPU Renderer Addon         |
    |                                      |
    |  +----------+  +------------------+  |
    |  | Glyph    |  | Cell Grid        |  |
    |  | Atlas    |  | Compute Shader   |  |
    |  | (GPU tex)|  | (color/attr/fg)  |  |
    |  +----------+  +------------------+  |
    |                                      |
    |  +-------------------------------+   |
    |  | Composition Pass (fragment)   |   |
    |  | glyph + bg + cursor + images  |   |
    |  | + notification rings          |   |
    |  | + spectrogram overlay         |   |
    |  +-------------------------------+   |
    +--------------------------------------+

The compute shader approach means we can do per-cell work (search match,
syntax highlight, diff coloring) as a GPU pass instead of CPU iteration.

---

## Layer 5: Shared Memory with Rust Sidecar (2-3 days)

The Rust sidecar (agent engine, Stream Deck, signal routing) can share
memory with the renderer via SharedArrayBuffer:

    Rust sidecar              Electron renderer
    +-----------+             +------------------+
    | screen    |  SharedAB   | GPU render       |
    | diffing   | <---------> | worker           |
    | agent     |  dirty-cell | reads bitmask    |
    | output    |  bitmask    | uploads only     |
    +-----------+             | changed cells    |
                              +------------------+

For this to work:
1. Sidecar runs screen diff logic (which cells changed since last frame)
2. Writes a dirty-cell bitmask into SharedArrayBuffer
3. Render worker reads bitmask, only re-uploads changed glyph textures
4. Zero-copy between compute and render

This matters when the sidecar is processing fast output (build logs, etc)
and we want to avoid re-rendering 2000 unchanged cells.

Alternative: Rust compiled to WASM running inside the render worker,
doing diff + atlas management in one thread.

---

## Layer 6: Inline Image Compositing (1 day)

Stock Hyper overlays images as DOM elements. This causes reflow, layer
promotion, and jank when scrolling. GPU-native approach:

    Terminal output
         |
    detect image escape (sixel / iTerm2 / kitty)
         |
    decode to ImageBitmap
         |
    upload as GPU texture
         |
    composite in same WebGL/WebGPU pass as text

No DOM overlays. No reflow. Images scroll with text at GPU speed.
This is critical for our spectrogram display, inline charts, and
any image-heavy agent output.

---

## Layer 7: Effect Pipeline (ongoing)

GPU-accelerated visual effects for the terminal chrome:

    Notification Rings    — radial gradient pulse on button areas
    Focus Glow            — soft edge glow on active pane border
    Cursor Trail          — fading cursor ghost (shader effect)
    Selection Highlight   — GPU-blended selection overlay
    Transparency/Blur     — vibrancy effect behind terminal
                           (Electron: setVibrancy or CSS backdrop-filter)

These are fragment shader effects composited over the terminal canvas.
Cheap on GPU, expensive or impossible on CPU.

---

## Priority Order

    +------+---------------------------------+---------+---------+
    | Step | What                            | Effort  | Impact  |
    +------+---------------------------------+---------+---------+
    |  1   | Electron GPU flags              | 5 min   | Medium  |
    |  2   | Verify WebGL addon is active    | 10 min  | High    |
    |  3   | OffscreenCanvas render worker   | 1-2 day | High    |
    |  4   | Inline image compositing        | 1 day   | High    |
    |  5   | Effect pipeline (glow, rings)   | 2-3 day | Medium  |
    |  6   | Shared memory with sidecar      | 2-3 day | Medium  |
    |  7   | WebGPU custom renderer          | 1-2 wk  | Future  |
    +------+---------------------------------+---------+---------+

Steps 1-2 are free wins. Step 3 is the biggest real-world improvement.
Step 4 matters once we have inline images/spectrogram. Steps 5-7 are
polish and future-proofing.

---

## What NOT to Do

- Don't rewrite the xterm.js parser. It's battle-tested and fast.
- Don't force WebGPU until WebGL2 is actually the bottleneck.
- Don't GPU-accelerate scrollback search — the buffer is CPU-optimal.
- Don't use WASM for the parser — xterm.js TypeScript is already fast,
  and WASM boundary crossing has overhead for the message volume.

The terminal's bottleneck is almost never the GPU. It's usually:
1. Main thread blocked during render (fix: OffscreenCanvas)
2. IPC overhead between Electron main/renderer (fix: direct node-pty)
3. Large output bursts flooding the parser (fix: flow control, not GPU)

GPU acceleration shines for VISUAL EFFECTS and IMAGE COMPOSITING,
not for making `cat bigfile.txt` faster. Optimize accordingly.
