/**
 * Haptix — asset manifest (prompts for tools/gen_assets.mjs).
 *
 * Style LOCKED to the flat-sticker look (thick black outline, vibrant flat colors, simple flat background
 * so the rembg cut is clean). Keep icon subjects SIMPLE + iconic — detailed subjects make the model
 * over-render (a realistic hand crept into the first estop). The hero scene keeps its background.
 */

export const DEFAULTS = Object.freeze({
    ckpt: 'Illustrious\\novaAnimeXL_ilV125.safetensors',
    stylePos: 'flat app icon, sticker style, thick bold black outline, vibrant flat colors, simple 2D vector, centered single subject, simple flat pastel background, clean, high contrast, masterpiece, best quality',
    neg: 'worst quality, low quality, blurry, jpeg artifacts, text, watermark, signature, logo, multiple panels, frame, border, grid, photo, 3d render, realistic shading, gradient mesh, extra limbs, bad anatomy, nsfw, nude, explicit, genitals',
    w: 1024, h: 1024,
    steps: 28, cfg: 5.0, sampler: 'euler_ancestral', scheduler: 'karras', seed: 7777,
});

const heroStyle = 'masterpiece, best quality, very aesthetic, humorous spicy fantasy illustration, dynamic comedic angle, expressive';
const heroPrompt = '(beautiful seductive female night elf:1.2), purple skin, long pointed ears, long white hair, glowing eyes, evil playful smirk, large breasts, leaning in and firmly grabbing a giant muscular barbarian man by the crotch with one hand, the huge barbarian flinching backward with a comically shocked wide-eyed open-mouth face, both fully clothed, fantasy tavern, focus on the grab and his shocked reaction';
const heroNeg = 'worst quality, low quality, blurry, text, watermark, nude, explicit, visible genitals, penis, bare crotch, photo, 3d, bad anatomy, extra limbs, extra fingers';

export const ASSETS = [
    // ---- hero illustration variants (README banner; pick one) ----------------------------------------
    { name: 'hero-grab-a', transparent: false, w: 1216, h: 832, seed: 99887, steps: 32, stylePos: heroStyle, prompt: heroPrompt, neg: heroNeg },
    { name: 'hero-grab-b', transparent: false, w: 1216, h: 832, seed: 13579, steps: 32, stylePos: heroStyle, prompt: heroPrompt, neg: heroNeg },
    { name: 'hero-grab-c', transparent: false, w: 1216, h: 832, seed: 24680, steps: 32, stylePos: heroStyle, prompt: heroPrompt, neg: heroNeg },

    // ---- interface icons (flat-sticker, transparent) -------------------------------------------------
    { name: 'launcher-heart', seed: 1001, prompt: 'a single glossy hot-pink love heart with a small yellow lightning bolt across it, cute, playful, glowing' },
    { name: 'icon-estop', seed: 3002, ckpt: 'SDXL\\Artwork\\zavychromaxl_v80.safetensors', prompt: 'a big glossy round red emergency push-button, shiny domed top, chunky metallic ring base, simple flat vector icon', neg: DEFAULTS.neg + ', text, letters, words, numbers, octagon, sign, scribble' },
    { name: 'icon-connect', seed: 2003, prompt: 'two glossy blue interlocking chain-link rings with a small spark, simple flat minimal icon', neg: DEFAULTS.neg + ', text, letters, scribble, bluetooth logo' },
    { name: 'icon-disconnect', seed: 1004, prompt: 'a white bluetooth symbol with a red diagonal slash through it on a grey rounded-square badge' },
    { name: 'icon-arm', seed: 3005, ckpt: 'SDXL\\Artwork\\zavychromaxl_v80.safetensors', prompt: 'a glossy green circle badge with one bold white lightning bolt in the center, simple flat vector icon', neg: DEFAULTS.neg + ', text, letters, triangle, scribble' },
    { name: 'icon-test', seed: 3006, ckpt: 'SDXL\\Artwork\\zavychromaxl_v80.safetensors', prompt: 'a simple glossy purple hand bell with two small motion lines beside it, flat vector icon', neg: DEFAULTS.neg + ', text, letters, scribble, device, gadget, remote, buttons' },
    { name: 'icon-intensity', seed: 1007, prompt: 'three rising flames small to large, orange and red gradient-free flat, simple icon' },
    { name: 'icon-sequence', seed: 1008, prompt: 'a single bold glossy teal sine wave line, simple clean icon' },
    { name: 'icon-pattern', seed: 3009, ckpt: 'SDXL\\Artwork\\zavychromaxl_v80.safetensors', prompt: 'a simple audio equalizer icon, five vertical bars of varying height, pink and purple, flat vector', neg: DEFAULTS.neg + ', mandala, ornate, circular, creature, animal, face, text' },
    { name: 'icon-calibrate', seed: 1010, prompt: 'a red and white target bullseye with a small pink heart in the center, simple icon' },
    { name: 'icon-arousal', seed: 1011, prompt: 'a heart-shaped gauge meter with a rising red fill and a needle, simple icon' },
    { name: 'icon-device', seed: 1012, prompt: 'a cute smooth rounded abstract gadget silhouette with a single glowing pink button, dark grey, simple icon, non-anatomical' },
];
