import { spawn } from 'child_process';
import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import * as https from 'https';

const MODELS_DIR = join(process.cwd(), 'tests', '.dt-models');
const BIN_DIR = join(process.cwd(), 'tests', '.bin');
const BINARY_NAME = 'gRPCServerCLI-macOS';
const BINARY_PATH = join(BIN_DIR, BINARY_NAME);

const REQUIRED_MODELS = [
  'juggernaut_xl_ragnarok_f16.ckpt',
  'juggernaut_xl_ragnarok_open_clip_vit_bigg14_f16.ckpt',
  'juggernaut_xl_ragnarok_clip_vit_l14_f16.ckpt',
  'sdxl_vae_v1.0_f16.ckpt',
  'sdxl_lightning_4_step_lora_f16.ckpt',
];

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadBinary(): Promise<void> {
  if (existsSync(BINARY_PATH)) return;
  mkdirSync(BIN_DIR, { recursive: true });

  const res = await fetch('https://api.github.com/repos/drawthingsai/draw-things-community/releases/latest');
  const release = await res.json();
  const asset = release.assets.find((a: any) => a.name === BINARY_NAME);
  if (!asset) throw new Error(`${BINARY_NAME} not found in latest release`);

  await downloadFile(asset.browser_download_url, BINARY_PATH);
  await new Promise<void>((resolve, reject) => {
    const chmod = spawn('chmod', ['+x', BINARY_PATH]);
    chmod.on('close', (code) => code === 0 ? resolve() : reject(new Error(`chmod failed: ${code}`)));
  });
}

function assertModelsPresent(): void {
  mkdirSync(MODELS_DIR, { recursive: true });
  const missing = REQUIRED_MODELS.filter(f => !existsSync(join(MODELS_DIR, f)));
  if (missing.length) {
    throw new Error(
      `Missing model files in ${MODELS_DIR}:\n${missing.map(f => `  - ${f}`).join('\n')}\n\nCopy them from your DT models folder.`
    );
  }
}

export default async function setup(): Promise<void> {
  await downloadBinary();
  assertModelsPresent();
}
