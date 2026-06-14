/**
 * Haptix — ComfyUI asset generator (transparent PNG icons + illustrations).
 *
 * Generates each asset in the manifest via a verified SDXL graph, removes the background (mtb rembg ->
 * RGBA), and saves to assets/. Node names were verified against the live /object_info (no hallucinated
 * nodes). Run:  node tools/gen_assets.mjs [comfyURL] [onlyNameSubstr]
 *   e.g.  node tools/gen_assets.mjs http://127.0.0.1:8188 hero    (or set HAPTIX_COMFY)
 *
 * Transparency: this server has no LayerDiffuse, so we render on a flat background and cut it with
 * "Image Remove Background Rembg (mtb)" (alpha_matting OFF — avoids the color-fringing seen with it ON).
 */

import fs from 'fs/promises';
import path from 'path';
import { ASSETS, DEFAULTS } from './asset_manifest.mjs';

const COMFY = process.argv[2] || process.env.HAPTIX_COMFY || 'http://127.0.0.1:8188';
const ONLY = process.argv[3] || '';
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'assets');
const CLIENT = `haptix-${Math.floor(performance.now())}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the ComfyUI API-format graph for one asset. */
function graph(a) {
    const ckpt = a.ckpt || DEFAULTS.ckpt;
    const pos = `${a.stylePos ?? DEFAULTS.stylePos}, ${a.prompt}`;
    const neg = a.neg || DEFAULTS.neg;
    const g = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['1', 1] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width: a.w || DEFAULTS.w, height: a.h || DEFAULTS.h, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: a.seed ?? DEFAULTS.seed, steps: a.steps || DEFAULTS.steps, cfg: a.cfg || DEFAULTS.cfg, sampler_name: DEFAULTS.sampler, scheduler: DEFAULTS.scheduler, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1.0 } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    };
    if (a.transparent === false) {
        g[8] = { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: `haptix/${a.name}` } };
    } else {
        g[7] = { class_type: 'Image Remove Background Rembg (mtb)', inputs: { image: ['6', 0], alpha_matting: false, alpha_matting_foreground_threshold: 240, alpha_matting_background_threshold: 10, alpha_matting_erode_size: 10, post_process_mask: true, bgcolor: '#00000000' } };
        g[8] = { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: `haptix/${a.name}` } };
    }
    return g;
}

async function queue(g) {
    const r = await fetch(`${COMFY}/prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: g, client_id: CLIENT }),
    });
    if (!r.ok) throw new Error(`/prompt ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).prompt_id;
}

async function waitFor(id, timeoutMs = 180000) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
        const r = await fetch(`${COMFY}/history/${id}`);
        if (r.ok) {
            const h = await r.json();
            if (h[id]?.outputs) return h[id];
        }
        await sleep(1500);
    }
    throw new Error(`timeout waiting for ${id}`);
}

async function saveOutputs(hist, name) {
    const saved = [];
    for (const node of Object.values(hist.outputs || {})) {
        for (const img of node.images || []) {
            const u = `${COMFY}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`;
            const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
            const dest = path.join(OUT, `${name}.png`);
            await fs.writeFile(dest, buf);
            saved.push(dest);
        }
    }
    return saved;
}

(async () => {
    await fs.mkdir(OUT, { recursive: true });
    const list = ASSETS.filter((a) => !ONLY || a.name.includes(ONLY));
    console.log(`ComfyUI: ${COMFY}  |  assets: ${list.length}${ONLY ? ` (filter="${ONLY}")` : ''}  |  out: ${OUT}`);
    for (const a of list) {
        const dest = path.join(OUT, `${a.name}.png`);
        if (!process.env.HAPTIX_FORCE && await fs.access(dest).then(() => true).catch(() => false)) {
            console.log(`  ${a.name} … skip (exists; set HAPTIX_FORCE=1 to redo)`); continue;
        }
        try {
            const id = await queue(graph(a));
            process.stdout.write(`  ${a.name} (${id.slice(0, 8)})… `);
            const hist = await waitFor(id);
            const saved = await saveOutputs(hist, a.name);
            console.log(saved.length ? `OK -> ${path.basename(saved[0])}` : 'NO OUTPUT');
        } catch (e) { console.log(`FAIL ${a.name}: ${e.message}`); }
    }
    console.log('done.');
})();
