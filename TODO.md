# TODO

## ✅ Done

- [x] Open sidebar view via ribbon icon
- [x] Sampler dropdown
- [x] Steps slider (1–100)
- [x] CFG scale slider (1–20, step 0.5)
- [x] Width & Height inputs
- [x] Generate button
- [x] Generated image saved to vault output folder
- [x] Image filename saved to dt-generated-images frontmatter
- [x] Plugin settings: gRPC host and output folder
- [x] Centralized DEFAULT_FORM_VALUES object
- [x] Default sampler DDIM Trailing
- [x] Default model flux_2_klein_9b_q8p.ckpt
- [x] Feedback via Obsidian Notice toasts
- [x] Form pre-populated from note frontmatter with per-field validation
- [x] Optional Input Image selector via vault file browser
- [x] Up to 3 optional Reference Image selectors
- [x] Input image sent in gRPC request
- [x] Reference images sent as hints in gRPC request
- [x] Console logging for received payload, decode errors, stream errors, and successful saves
- [x] Form controls and Generate button disabled + visually dimmed by default; enabled only when active note contains a code block
- [x] Prompt extraction logic
- [x] Editor prompt decoration
- [x] README.md

## 🗺️ Features

- [ ] Preselectable image dimension presets
- [x] Display last N generated images in sidebar from frontmatter
- [ ] gRPC server availability indicator — controls disabled + warning until server reachable

## 🚀 Polish & Release

- [ ] GitHub Actions release workflow
- [ ] Submission-ready: verify normalizePath() coverage, manifest.json (authorUrl empty), release assets

## 🧪 Testing

- [x] Start gRPCServerCLI Docker container with Juggernaut XL + 2-step turbo LoRA as test fixture
- [ ] Run integration tests against it
- [ ] Tear down container after tests
