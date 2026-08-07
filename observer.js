/**
 * observer - lets text-only models see images through opencode.
 *
 * 1. chat.message: decode pasted base64 images, save them to files, drop a
 *    "[Image saved to: <path>]" marker in their place.
 * 2. experimental.chat.system.transform: tell non-multimodal models to hand
 *    image reading to the @observer sub-agent.
 * 3. ui: toast on save, an images tool, and a plain HTML gallery of the cache.
 *
 * Global install:
 *   ~/.config/opencode/plugins/observer.js
 *   ~/.config/opencode/agents/observer.md
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { tool } from "@opencode-ai/plugin";

const DEFAULT_IMAGE_ROOT = process.env.XDG_CACHE_HOME
  ? path.join(process.env.XDG_CACHE_HOME, "opencode", "images")
  : path.join(os.homedir(), ".local", "share", "opencode", "images");

// Don't save absurd screenshots unless the user opts in. 8 MB is past anything
// a normal screenshot hits.
const MAX_IMAGE_BYTES = Number(process.env.OBSERVER_MAX_IMAGE_BYTES || 8 * 1024 * 1024);

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const IMG_NAME = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

function isImagePart(part) {
  const type = part?.type;
  if (type !== "file" && type !== "image") return false;
  const mime = String(part.mediaType || part.mime || "").toLowerCase();
  return mime === "image/*" || mime.startsWith("image/");
}

// A model can see images when it advertises image input.
function isMultimodal(model) {
  if (!model) return false;
  const caps = model.capabilities;
  if (caps && caps.input) {
    if (typeof caps.input.image === "boolean") return caps.input.image;
  }
  if (Array.isArray(model.input)) return model.input.includes("image");
  return false;
}

// Decode a part's payload into a Buffer. Handles data: URLs, raw base64,
// Buffers, Uint8Arrays, and URL objects.
function toBuffer(part) {
  let raw;
  if (part.data !== undefined && part.data !== null) raw = part.data;
  else if (part.url) raw = part.url;
  else return null;

  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof URL) raw = raw.href;
  if (typeof raw !== "string") return null;

  if (raw.startsWith("data:")) {
    const comma = raw.indexOf(",");
    if (comma < 0) return null;
    return Buffer.from(raw.slice(comma + 1), "base64");
  }
  return Buffer.from(raw, "base64");
}

function mimeFor(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
      avif: "image/avif",
      svg: "image/svg+xml",
    }[ext] || "image/png"
  );
}

function extension(mime) {
  const m = String(mime || "").toLowerCase();
  return MIME_EXT[m] || m.split("/").pop() || "png";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function bytesToHuman(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export const ObserverPlugin = async ({ directory, project, client }, options = {}) => {
  const agentName = options.agent || "observer";
  const imageRoot = options.image || DEFAULT_IMAGE_ROOT;
  const indexFile = path.join(imageRoot, ".index.json");
  const page = options.page || "index.html";
  const model = options.model || (await detectModel(agentName, directory));

  const loadIndex = async () => {
    try {
      return JSON.parse(await fs.readFile(indexFile, "utf8"));
    } catch {
      return {};
    }
  };
  const saveIndex = async (idx) => {
    await fs.mkdir(imageRoot, { recursive: true });
    await fs.writeFile(indexFile, JSON.stringify(idx));
  };
  const exists = async (f) => {
    try {
      await fs.access(f);
      return true;
    } catch {
      return false;
    }
  };

  // imageHash -> file path, shared across sessions/messages. Identical pastes
  // reuse one file and (hopefully) one @observer read, instead of re-billing
  // the pixels every time.
  const idx = await loadIndex();

  const scanCache = async () => {
    let names = [];
    try {
      names = await fs.readdir(imageRoot);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!IMG_NAME.test(name)) continue;
      const p = path.join(imageRoot, name);
      try {
        const s = await fs.stat(p);
        files.push({ name, path: p, size: s.size, mtime: s.mtime });
      } catch {
        // race: file deleted between readdir and stat
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  };

  const buildGalleryHtml = (files, total) => {
    const rows = files
      .map(
        (f) => `
    <a class="cell" href="${escapeHtml(f.name)}">
      <img src="${escapeHtml(f.name)}" loading="lazy" decoding="async" alt="${escapeHtml(f.name)}">
      <span class="name">${escapeHtml(f.name)}</span>
    </a>`,
      )
      .join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>images</title>
<style>
  :root{ color-scheme: dark; }
  *{ box-sizing: border-box; }
  body{ margin:0; background:#0f0f0f; color:#c9c9c9;
        font-family: ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
        font-size:13px; line-height:1.5; }
  main{ max-width:980px; margin:0 auto; padding:24px 20px 56px; }
  .count{ color:#8a8a8a; padding:0 0 14px; border-bottom:1px solid #262626; margin-bottom:22px; }
  .count b{ color:#e0e0e0; font-weight:600; }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:14px; }
  .cell{ display:block; border:1px solid #262626; padding:8px; color:inherit; text-decoration:none; }
  .cell:hover{ border-color:#505050; }
  .cell img{ display:block; width:100%; height:130px; object-fit:cover; background:#000; border:1px solid #1a1a1a; }
  .name{ display:block; margin-top:8px; font-size:11px; color:#8a8a8a;
         overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .empty{ color:#666; }
</style>
</head>
<body>
<main>
  <p class="count"><b>${files.length}</b> · ${bytesToHuman(total)}</p>
  ${rows ? `<div class="grid">${rows}</div>` : `<p class="empty">nothing here.</p>`}
</main>
</body>
</html>`;
  };

  const writeGallery = async () => {
    const files = await scanCache();
    const total = files.reduce((s, f) => s + f.size, 0);
    await fs.mkdir(imageRoot, { recursive: true });
    await fs.writeFile(path.join(imageRoot, page), buildGalleryHtml(files, total));
    return { files, total };
  };

  return {
    // Job 1: intercept pasted images and stash them as files.
    "chat.message": async (input, output) => {
      const parts = output.parts;
      if (!Array.isArray(parts) || parts.length === 0) return;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part || !isImagePart(part)) continue;

        const data = toBuffer(part);
        if (!data || data.length === 0) continue; // ignore malformed image
        if (data.length > MAX_IMAGE_BYTES) {
          console.warn(
            `[observer] skipping oversized image (${(data.length / 1024 / 1024).toFixed(1)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB); not sent to vision model`,
          );
          continue;
        }

        const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
        const ext = extension(part.mediaType || part.mime);
        const name = `${hash}.${ext}`;
        let file = idx[hash];
        if (!file || !(await exists(file))) {
          file = path.join(imageRoot, name);
          await fs.mkdir(imageRoot, { recursive: true });
          await fs.writeFile(file, data);
          idx[hash] = file;
          await saveIndex(idx);
          try {
            await writeGallery();
          } catch {
            // gallery is a nicety; never block a paste on it
          }
          try {
            await client?.tui?.showToast?.({
              body: { message: `observer: ${name} (${bytesToHuman(data.length)})`, variant: "info" },
            });
          } catch {
            // TUI not available (headless); fall through
          }
          console.log(`[observer] saved ${name} (${bytesToHuman(data.length)})`);
        }
        // Reuse a shared, predictable path, so identical pasted images map
        // to one file and the model can skip re-analyzing what it covered.
        parts[i] = {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          text: `[Image saved to: ${file}]`,
        };
      }
    },

    // Job 2: teach text-only models to pass image reading to @observer.
    "experimental.chat.system.transform": async (input, output) => {
      if (isMultimodal(input.model)) return;

      const block = [
        "",
        "## Image Reading via @observer",
        "",
        "You cannot see images directly. When the user attaches an image, the",
        "message will contain a marker like:  [Image saved to: <path>]",
        "",
        "Whenever you encounter such a marker, BEFORE answering anything that",
        "depends on the image:",
        "",
        `1. Call the @${agentName} sub-agent using the <task> tool.`,
        "2. Tell it the path to the image file from the marker.",
        "3. Ask it to read the image with the scenario that fits the job",
        "   (error stack, chart, recreate a page, issue area, OCR text).",
        "4. Use the text description it returns to answer the user.",
        "",
        "Token policy (save on the vision model):",
        `- Read each image with @${agentName} exactly ONCE. If the same marker`,
        "  path was already analyzed earlier in this conversation, do NOT call",
        `  @${agentName} again — reuse the description you already have.`,
        "- Ask @observer to answer with its default CONCISE summary unless the",
        "  user explicitly asked for full detail.",
        "",
        `- The \`images\` tool lists the cached images; the gallery is \`${page}\``,
        "  in the cache directory (open it in a browser for a thumbnail view).",
        "",
        `Never guess the image content yourself. Always route through @${agentName}.`,
      ];
      const marker = block[1];
      if (output.system.some((s) => String(s).includes(marker))) return;
      output.system.push(block.join("\n"));
    },

    // Job 3: the built-in UI. The images tool shows the cache as a board in
    // the TUI and attaches every saved image so opencode renders them as
    // clickable thumbnails (a custom tool can't emit raw HTML, this is the
    // supported surface). It also rewrites the standalone gallery page.
    tool: {
      images: tool({
        description:
          "Show the observer image cache as a board in the TUI: count, size, and every saved image attached so it can be opened. Also rewrites the HTML gallery page.",
        args: {},
        async execute() {
          const { files, total } = await writeGallery();
          const rows = files
            .map(
              (f) =>
                `  ${f.name.padEnd(24)} ${bytesToHuman(f.size).padStart(7)}  ${f.mtime.toISOString().slice(0, 19).replace("T", " ")}`,
            )
            .join("\n");
          const text = [
            `observer · image cache`,
            `  files     ${files.length}`,
            `  size      ${bytesToHuman(total)}`,
            ...(model
              ? [`  model     ${model}`, `  key       ✓ set via opencode auth login`]
              : [
                  `  model     none — set a multimodal model in ${agentName}.md`,
                  `  key       run: opencode auth login, or export OPENCODE_<PROVIDER>_API_KEY`,
                ]),
            `  gallery   ${path.join(imageRoot, page)}`,
            `  storage   scratch cache — delete any file here when the session ends`,
            "  images",
          ].join("\n");
          return {
            title: `observer · ${files.length} image${files.length === 1 ? "" : "s"} (${bytesToHuman(total)})`,
            output: [text, rows].filter(Boolean).join("\n"),
            attachments: files.map((f) => ({
              type: "file",
              mime: mimeFor(f.name),
              url: f.path,
              filename: f.name,
            })),
          };
        },
      }),
    },
  };
};

// Best-effort: read the observer agent's `model:` from the usual locations
// so the report shows what actually reads the images.
async function detectModel(agentName, directory) {
  const candidates = [];
  if (directory) {
    candidates.push(path.join(directory, ".opencode", "agents", `${agentName}.md`));
    candidates.push(path.join(directory, ".opencode", "agent", `${agentName}.md`));
  }
  const home = os.homedir();
  candidates.push(path.join(home, ".config", "opencode", "agents", `${agentName}.md`));
  candidates.push(path.join(home, ".config", "opencode", "agent", `${agentName}.md`));
  for (const c of candidates) {
    try {
      const text = await fs.readFile(c, "utf8");
      const m = /^model:\s*(\S+)/m.exec(text.slice(0, 2000));
      if (m) return m[1];
    } catch {
      // not there, try next
    }
  }
  return "";
}

export default ObserverPlugin;
