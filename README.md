# Draw Things gRPC Bridge — Obsidian Plugin

Generate images directly in Obsidian using the **Draw Things** macOS/iOS app via gRPC.

## Features

✅ Write prompts in `` code blocks  
✅ Configure model, sampler, steps, CFG, dimensions via sidebar UI  
✅ Select input/reference images from your vault  
✅ Frontmatter integration: `dt-*` fields pre-populate settings; results tracked in `dt-generated-images`  
✅ SHA-256 deduplication for image uploads  
✅ Chunked streaming for large payloads  
✅ Typed gRPC client via `ts-proto`

## Setup

1. **Draw Things**: Enable gRPC server in Draw Things settings (default: `127.0.0.1:7888`)
2. **Install plugin**: Clone or copy this folder to your Obsidian vault's `.obsidian/plugins/` directory
3. **Enable**: Toggle on in Obsidian → Settings → Community plugins

## Usage

1. Open a note and add a prompt block:

   ````markdown
   
   a serene mountain lake at sunrise, photorealistic
   ```
   ````

2. Open the Draw Things sidebar (ribbon icon or command palette)
3. Adjust settings or let frontmatter pre-fill them:

   ```yaml
   ---
   dt-model: flux_2_klein_9b_q8p.ckpt
   dt-steps: 20
   dt-cfg: 7.5
   dt-sampler: 0
   dt-width: 768
   dt-height: 512
   ---
   ```

4. Click **Generate** → image saves to your vault (default: `Generated/` folder)

## Development

```bash
# Install deps
npm install

# Build plugin
npm run build

# Dev watch mode
npm run dev

# Regenerate gRPC types (if proto changes)
npm run codegen

# Run integration tests (requires Draw Things server + test images)
npm run test:dt
```

## Architecture

- **`lib.ts`**: Core gRPC client, tensor decoding, upload logic (exports `makeClient`, `generate`, `decodeTensor`, `ensureUploaded`)
- **`main.ts`**: Obsidian plugin lifecycle, UI view, frontmatter handling
- **`proto/draw_things.proto`**: gRPC service definition (source of truth)
- **`proto/generated/draw_things.ts`**: Typed stubs via `ts-proto` (do not edit)
- **`tests/dt-test.ts`**: Node.js integration tests (uses shared `lib.ts` exports)

## Dependencies

| Package | Purpose |
|---------|---------|
| `@grpc/grpc-js` | gRPC client runtime |
| `@bufbuild/protobuf` | Proto message serialization |
| `flatbuffers` | Draw Things config encoding (field indices 1-12) |
| `ts-proto` | Dev: generate typed stubs from proto |

## Troubleshooting

- **Connection refused**: Ensure Draw Things gRPC server is running and host matches plugin settings
- **No image returned**: Check Draw Things logs for generation errors; verify prompt block syntax
- **Upload failures**: Large images may hit gRPC limits; ensure `grpc.max_*_message_length` is set (default: 100MB)

## License

MIT © György Gutai
