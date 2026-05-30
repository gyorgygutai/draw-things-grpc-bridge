# SPECS.md

**Project goal**: Obsidian plugin that sends prompts to Draw Things.

## Features

## ✅ Open sidebar view via ribbon icon

## ✅ Sampler dropdown

## ✅ Steps slider (1–100)

## ✅ CFG scale slider (1–20, step 0.5)

## ✅ Width & Height inputs

## ✅ Generate button

## ✅ Generated image saved to vault output folder

## ✅ Image filename saved to dt-generated-images frontmatter

## ✅ Plugin settings: gRPC host and output folder

## ✅ Centralized DEFAULT_FORM_VALUES object

## ✅ Default sampler DDIM Trailing

## ✅ Default model flux_2_klein_9b_q8p.ckpt

## ✅ Feedback via Obsidian Notice toasts

## ✅ Form pre-populated from note frontmatter with per-field validation

## ✅ Optional Input Image selector via vault file browser

## ✅ Up to 3 optional Reference Image selectors

## ✅ Input image sent in gRPC request

## ✅ Reference images sent as hints in gRPC request

## ✅ Console logging for received payload, decode errors, stream errors, and successful saves

## ✅ Form controls and Generate button disabled + visually dimmed by default; enabled only when active note contains a  code block

## ✅ Prompt extraction logic

Prompt extracted via `##Prompt` heading → `---` section parser (case-insensitive heading, first match wins, content trimmed of blank lines).

## ✅ Editor prompt decoration

Subtle background tint + gutter marker on the prompt region when the DT sidebar is open; cleared on sidebar close.

When the DT sidebar is visible, the prompt region in the active note receives a subtle background tint and a 4px accent-colored gutter marker; cleared automatically when the sidebar is hidden or a note without a prompt section is active. Implemented via a CM6 `StateField` + `gutter` extension registered at plugin load, driven by `IntersectionObserver` on the sidebar container for accurate visibility detection across all layout states.
