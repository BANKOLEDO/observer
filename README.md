# observer — let text-only models "see" images in opencode

DeepSeek‑V4 / any non‑multimodal model can't read images natively. The DeepSeek
**API is text-only**: `deepseek-v4-flash` returns *"this model does not support
image input"*, because vision exists only in the free web chat (chat.deepseek.com),
not in any API image endpoint. This plugin works around it by routing every
image through a small, multimodal `@observer` sub‑agent that runs in its own
sub‑session.

No image data ever enters the main model's context, so it keeps working on a
cheap, text‑only, long‑context model. You pay for a vision model only for the
tiny describe step.

## How it works

```
you paste an image
   │
   ▼
plugin: chat.message        → decode base64 → save to file → replace with
                              "[Image saved to: <path>]" text
   │
   ▼
plugin: system.transform    → text-only model is told:
                              "call @observer sub-agent to read that file"
   │
   ▼
@observer (multimodal)      → read tool opens the PNG, produces a text
                              description (stack / chart / page / OCR)
   │
   ▼
  text description  → back to DeepSeek as normal text
```

## Files

| File          | Purpose                                                         |
| ------------- | --------------------------------------------------------------- |
| `observer.js` | The plugin (dispatcher) + a small baked-in opencode UI          |
| `observer.md` | The multimodal `@observer` sub-agent (image reader)             |
| `index.html`  | The deployable landing page for the plugin (static, no deps)    |

There's a deployable static landing page at [`index.html`](./index.html) —
open it or host it anywhere (GitHub Pages / Netlify / Vercel). One file, no
build step, only loads a system monospace font.

## The opencode UI

The plugin also ships a small built-in UI so you don't leave the TUI:

- **Toast + one log line** when an image is saved (`[observer] saved <name> (<size>)`).
- **`images` tool** — ask your model "show me the image cache" (or call it
  directly). It prints a board (count / size / model) and **attaches every
  cached image** so opencode renders them as openable items in the chat.
- **`index.html` gallery** in the image cache dir — a bare thumbnail grid of
  everything `@observer` has seen. Delete freely; it's just a scratch cache.

Options when registering via `plugin:`: `agent` (sub-agent name), `image`
(where images are saved), `model` (shown in the board; auto-detected from the
agent file if omitted), `page` (gallery filename, default `index.html`).

## Installing it globally (all your codebases)

Put the two files in opencode's **global** config so they load in every
project on this machine (not just this one):

```
~/.config/opencode/plugins/observer.js      # or %USERPROFILE%\.config\opencode\plugins\
~/.config/opencode/agents/observer.md       # or ~/.config/opencode\agent\
```

Both dirs are scanned automatically at startup — no `plugin:` entry needed.

That's what "stored so it works across all my codebase" means: the files live
under `~/.config/opencode/` (global scope), which opencode merges into every
project. A project can also keep its own copies under `.opencode/plugins/`
and `.opencode/agents/` to override for a single repo.

### One global permission (already added for you)

Images are cached under `~/.local/share/opencode/images/`. The sub-agent must
be allowed to `read` that directory, so `opencode.jsonc` (global) contains:

```jsonc
{
  "permission": {
    "external_directory": {
      "~/.local/share/opencode/images/**": "allow"
    }
  }
}
```

## 1‑minute setup checklist

1. Put `observer.js` under `plugins/` and `observer.md` under `agents/`
   (already done on this machine).
2. Edit `~/.config/opencode/agents/observer.md` → set `model:` to a
   **multimodal** model you have credentials for (this is the only "vision"
   step and the only thing it's used for):
   ```yaml
   model: google/gemini-3.5-flash-lite   # free tier
   # or: openai/gpt-4o, anthropic/claude-sonnet-4-6, moonshotai/kimi-k2.6 ...
   ```
3. **Add the API key for that vision provider.** Only this sub-agent pays
   for pixels, so the key belongs to it — your main model keeps its own.
   Either log in or set the matching env var:
   ```sh
   opencode auth login            # pick the provider, paste the key

   # or, non-interactively:
   export OPENCODE_GOOGLE_API_KEY=...     # for google/gemini-*
   export OPENCODE_OPENAI_API_KEY=...     # for openai/*
   export OPENCODE_ANTHROPIC_API_KEY=...  # for anthropic/*
   ```
4. Keep using your cheap/free main model (e.g. `deepseek-v4`) for everything
   else.
5. **Quit and restart opencode** — config, plugins, and keys are read once at
   startup and are not hot‑reloaded.

## How to use

Just paste an image into the prompt like normal (drag & drop / screenshot /
`Ctrl+V`), type your question, and send. The main model will detect the saved
image marker and delegate reading to `@observer` automatically.

Try it with:
- an error stack screenshot → "what is the error and how do I fix it?"
- a chart → "read the numbers and give key insights"
- a webpage design mockup → "recreate this page in HTML/CSS"
- a hand‑drawn sketch → "turn this into a page"
- OCR → "extract the text from this image"

## Customization

- **Agent name**: to rename `@observer`, set the plugin's `agent` option when
  registering it via `plugin:` in config:
  ```jsonc
  "plugin": [
    ["/abs/path/to/observer.js", { "agent": "my-vision", "image": "C:/tmp/obs" }]
  ]
  ```
  (options: `agent` = sub-agent name used in the prompt, `image` = where to
  save the decoded images.)

- **@observer's behavior**: all scenario logic lives in `observer.md`
  (modes Error‑Log > Chart > Issue > Page > OCR, with priority). Edit that
  file to add modes or tweak prompts — no need to touch the JS.

- **Cleanup**: saved images accumulate under `~/.local/share/opencode/images/`
  — delete freely; they're just a scratch cache.

## Cost

- Image → text conversion is done once per image by a (possibly) cheap/vision
  model. Everything else stays on your normal model.
- No image ever enters the main context, so DeepSeek‑V4's big 1M context is
  never polluted by base64 blobs and won't trigger early compaction.

## Troubleshooting

- **Images aren't saved** → check the plugin loaded: run `opencode` and look
  for `[observer]` log lines, or verify the files exist under
  `~/.cache`/`.local/share/opencode/images/`.
- **@observer says it can't read the file** — make sure your `model:` is
  multimodal, and the `external_directory` permission allows
  `~/.local/share/opencode/images/**`.
- **Nothing changed after editing** → restart opencode (config is loaded once).