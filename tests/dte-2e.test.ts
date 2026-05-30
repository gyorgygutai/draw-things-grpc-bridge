import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { generate } from '../src/lib';
import { getClient } from './setup';

const TEMP_OUTPUT = join(process.cwd(), 'tests', 'temp-output');

const mockVault = {
  createFolder: async (_path: string) => {
    mkdirSync(TEMP_OUTPUT, { recursive: true });
  },
  createBinary: async (_path: string, buf: ArrayBuffer) => {
    const filename = _path.split('/').pop()!;
    writeFileSync(join(TEMP_OUTPUT, filename), Buffer.from(buf));
  },
};

describe('DT gRPC E2E', () => {
  it('generates image with prompt + LoRA + correct settings', async () => {
    mkdirSync(TEMP_OUTPUT, { recursive: true });

    const filename = await generate(
      getClient(),
      'a test prompt',
      4,
      1,
      5,
      896,
      1152,
      Math.floor(Math.random() * 0xffffffff),
      'juggernaut_xl_ragnarok_f16.ckpt',
      mockVault,
      '',
      undefined,
      undefined,
      'sdxl_lightning_4_step_lora_f16.ckpt',
    );

    expect(filename).toMatch(/\.png$/);
    expect(existsSync(join(TEMP_OUTPUT, filename))).toBe(true);
  }, 120_000);
});
