import { normalizePath } from "obsidian";
import * as flatbuffers from "flatbuffers";
import * as grpc from "@grpc/grpc-js";
import {
  ImageGenerationServiceClient,
  FileListRequest,
  FileUploadRequest,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ChunkState,
  DeviceType,
  HintProto,
  TensorAndWeight,
  MetadataOverride,
} from "../proto/generated/proto/draw_things";
import {
  GenerationConfiguration,
  SamplerType,
} from "../proto/generated/config_generated";

const HEADER_BYTES = 68;
const CHUNK_SIZE = 1024 * 1024;

function f16ToF32(h: number): number {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function decodeTensor(raw: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } {
  const isPNG = [0x89, 0x50, 0x4e, 0x47].every((b, i) => raw[i] === b);
  const isJPEG = [0xff, 0xd8].every((b, i) => raw[i] === b);
  if (isPNG || isJPEG) throw new Error("Encoded image returned — decode via Image element");
  if (raw.byteLength < HEADER_BYTES) throw new Error(`Tensor too small: ${raw.byteLength}`);

  const aligned = new Uint8Array(raw.byteLength);
  aligned.set(raw);
  const hdr = new Uint32Array(aligned.buffer, 0, 17);
  const height   = hdr[6];
  const width    = hdr[7];
  const channels = hdr[8];
  if (width === 0 || height === 0) throw new Error(`Bad tensor dims: ${width}x${height}`);

  const pixelCount = width * height;
  const rgbSize    = pixelCount * 3;
  const rgbaSize   = pixelCount * 4;
  const payload    = aligned.byteLength - HEADER_BYTES;

  if (payload === rgbaSize || payload === rgbSize) {
    const src = aligned.subarray(HEADER_BYTES);
    const out = new Uint8ClampedArray(pixelCount * 3);
    if (payload === rgbaSize) {
      for (let i = 0; i < pixelCount; i++) { out[i*3]=src[i*4]; out[i*3+1]=src[i*4+1]; out[i*3+2]=src[i*4+2]; }
    } else {
      out.set(src.subarray(0, rgbSize));
    }
    return { data: out, width, height };
  }

  const f16 = new Uint16Array(aligned.buffer, HEADER_BYTES, pixelCount * channels);
  const out  = new Uint8ClampedArray(pixelCount * 3);
  if (channels === 4) {
    for (let i = 0; i < pixelCount; i++) {
      out[i*3]   = Math.max(0, Math.min(255, Math.round((f16ToF32(f16[i*4])   + 1.0) * 127.0)));
      out[i*3+1] = Math.max(0, Math.min(255, Math.round((f16ToF32(f16[i*4+1]) + 1.0) * 127.0)));
      out[i*3+2] = Math.max(0, Math.min(255, Math.round((f16ToF32(f16[i*4+2]) + 1.0) * 127.0)));
    }
  } else {
    for (let i = 0; i < pixelCount * channels; i++) {
      out[i] = Math.max(0, Math.min(255, Math.round((f16ToF32(f16[i]) + 1.0) * 127.0)));
    }
  }
  return { data: out, width, height };
}

function buildConfigBuffer(
  model: string,
  steps: number,
  cfg: number,
  seed: number,
  w: number,
  h: number,
  sampler: SamplerType
): Uint8Array {
  const builder = new flatbuffers.Builder(512);
  const modelOffset = builder.createString(model);

  GenerationConfiguration.startGenerationConfiguration(builder);
  GenerationConfiguration.addStartWidth(builder, Math.floor(w / 64));
  GenerationConfiguration.addStartHeight(builder, Math.floor(h / 64));
  GenerationConfiguration.addSeed(builder, seed);
  GenerationConfiguration.addSteps(builder, steps);
  GenerationConfiguration.addGuidanceScale(builder, cfg);
  GenerationConfiguration.addStrength(builder, 1.0);
  GenerationConfiguration.addModel(builder, modelOffset);
  GenerationConfiguration.addSampler(builder, sampler);
  GenerationConfiguration.addBatchCount(builder, 1);
  GenerationConfiguration.addBatchSize(builder, 1);
  GenerationConfiguration.addClipSkip(builder, 1);
  GenerationConfiguration.addSeedMode(builder, 0);
  GenerationConfiguration.addT5TextEncoder(builder, true);
  GenerationConfiguration.addSeparateClipL(builder, false);
  GenerationConfiguration.addSeparateOpenClipG(builder, false);
  GenerationConfiguration.addSpeedUpWithGuidanceEmbed(builder, true);
  GenerationConfiguration.addResolutionDependentShift(builder, true);

  const config = GenerationConfiguration.endGenerationConfiguration(builder);
  builder.finish(config);

  return builder.asUint8Array();
}

async function filesExist(client: ImageGenerationServiceClient, hexHashes: string[]): Promise<boolean[]> {
  return new Promise((resolve, reject) => {
    const req = FileListRequest.create({ filesWithHash: hexHashes });
    client.filesExist(req, (err, response) => {
      if (err) return reject(err);
      if (!response) return resolve(hexHashes.map(() => false));
      resolve(response.existences);
    });
  });
}

async function uploadFile(client: ImageGenerationServiceClient, bytes: Uint8Array, hash: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const hex = toHex(hash);
    const call = client.uploadFile();
    call.on("error", reject);
    call.on("end", resolve);

    call.write(FileUploadRequest.create({
      initRequest: { filename: hex, sha256: hash, totalSize: bytes.length },
    }));

    let offset = 0;
    while (offset < bytes.length) {
      const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
      call.write(FileUploadRequest.create({
        chunk: { content: slice, filename: hex, offset },
      }));
      offset += slice.length;
    }
    call.end();
  });
}

export async function ensureUploaded(client: ImageGenerationServiceClient, bytes: Uint8Array): Promise<Uint8Array> {
  const hash = await sha256(bytes);
  const hex  = toHex(hash);
  const exists = await filesExist(client, [hex]);
  if (!exists[0]) {
    console.log("[DT] Uploading image:", hex);
    await uploadFile(client, bytes, hash);
  } else {
    console.log("[DT] Image already on server:", hex);
  }
  return hash;
}

function buildRequest(
  prompt: string,
  steps: number,
  cfg: number,
  sampler: SamplerType,
  w: number,
  h: number,
  seed: number,
  model: string,
  inputImageHash?: Uint8Array,
  refImageHashes?: Uint8Array[],
  lora?: string
): ImageGenerationRequest {
  const configuration = buildConfigBuffer(model, steps, cfg, seed, w, h, sampler);

  let override: any = undefined;
  if (lora) {
    const loraSpec = [{ file: lora, weight: 1.0, mode: 0 }];
    override = MetadataOverride.create({
      models: new Uint8Array(),
      loras: new TextEncoder().encode(JSON.stringify(loraSpec)),
      controlNets: new Uint8Array(),
      textualInversions: new Uint8Array(),
      upscalers: new Uint8Array(),
    });
  }

  const hints: HintProto[] = (refImageHashes ?? []).map(hash =>
    HintProto.create({
      hintType: "reference",
      tensors: [TensorAndWeight.create({ tensor: hash, weight: 1.0 })],
    })
  );

  return ImageGenerationRequest.create({
    prompt,
    negativePrompt: "",
    configuration,
    override,
    user: "obsidian",
    device: DeviceType.LAPTOP,
    chunked: true,
    image: inputImageHash,
    hints,
  });
}

export async function generate(
  client: ImageGenerationServiceClient,
  prompt: string,
  steps: number,
  cfg: number,
  sampler: SamplerType,
  w: number,
  h: number,
  seed: number,
  model: string,
  vault: any,
  folder: string,
  inputImageBytes?: Uint8Array,
  refImageBytes?: Uint8Array[],
  lora?: string
): Promise<string> {
  let inputImageHash: Uint8Array | undefined;
  if (inputImageBytes) {
    inputImageHash = await ensureUploaded(client, inputImageBytes);
  }

  const refImageHashes: Uint8Array[] = [];
  if (refImageBytes?.length) {
    for (const bytes of refImageBytes) {
      refImageHashes.push(await ensureUploaded(client, bytes));
    }
  }

  const request = buildRequest(prompt, steps, cfg, sampler, w, h, seed, model, inputImageHash, refImageHashes, lora);

  return new Promise((resolve, reject) => {
    const pending: Uint8Array[] = [];
    const images:  Uint8Array[] = [];

    const call = client.generateImage(request);

    call.on("data", (response: ImageGenerationResponse) => {
      const chunks = response.generatedImages;
      if (!chunks.length) return;

      if (response.chunkState === ChunkState.MORE_CHUNKS) {
        pending.push(...chunks);
      } else {
        if (pending.length > 0) {
          pending.push(...chunks);
          const total  = pending.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of pending) { merged.set(c, off); off += c.length; }
          images.push(merged);
          pending.length = 0;
        } else {
          images.push(...chunks);
        }
      }
    });

    call.on("error", (err) => {
      console.error("[DT] gRPC stream error:", err);
      reject(err);
    });

    call.on("end", async () => {
      if (pending.length > 0) {
        const total  = pending.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of pending) { merged.set(c, off); off += c.length; }
        images.push(merged);
      }

      if (images.length === 0) return reject(new Error("No image returned"));

      console.log("[DT] Received image payload, length:", images[0].byteLength,
        "first bytes:", Array.from(images[0].subarray(0, 20)).map(b => b.toString(16).padStart(2, "0")).join(" "));

      try {
        const { data, width, height } = decodeTensor(images[0]);
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          rgba[i*4] = data[i*3]; rgba[i*4+1] = data[i*3+1]; rgba[i*4+2] = data[i*3+2]; rgba[i*4+3] = 255;
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx    = canvas.getContext("2d")!;
        ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buf  = await blob.arrayBuffer();
        const name = `dt_${Date.now()}.png`;
        await vault.createFolder(folder).catch((e: any) => {
          if (!e?.message?.includes("already exists")) throw e;
        });
        await vault.createBinary(normalizePath(`${folder}/${name}`), buf);
        resolve(name);
      } catch (e) {
        console.error("[DT] Decode/save error:", e);
        reject(e);
      }
    });
  });
}

export function makeClient(host: string): ImageGenerationServiceClient {
  return new ImageGenerationServiceClient(host, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 100 * 1024 * 1024,
    "grpc.max_send_message_length":    100 * 1024 * 1024,
  });
}