import { afterAll, beforeAll } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import * as net from 'net';
import { Canvas } from 'canvas';
import * as grpc from '@grpc/grpc-js';
import { makeClient } from '../src/lib';
import type { ImageGenerationServiceClient } from '../proto/generated/proto/draw_things';

// OffscreenCanvas polyfill — must run in the test worker, not in globalSetup
(globalThis as any).OffscreenCanvas = Canvas;

const MODELS_DIR = join(process.cwd(), 'tests', '.dt-models');
const BIN_DIR = join(process.cwd(), 'tests', '.bin');
const BINARY_NAME = 'gRPCServerCLI-macOS';
const BINARY_PATH = join(BIN_DIR, BINARY_NAME);
const HOST = '127.0.0.1';
const PORT = 7859;
const CLIENT_HOST = `${HOST}:${PORT}`;

let serverProcess: ChildProcess | null = null;
let _client: ImageGenerationServiceClient | null = null;

export function getClient(): ImageGenerationServiceClient {
  if (!_client) throw new Error('gRPC client not initialised — beforeAll has not completed');
  return _client;
}

function killExistingServer(): Promise<void> {
  return new Promise((resolve) => {
    try {
      execSync(`pkill -9 -f "${BINARY_NAME}"`, { stdio: 'ignore' });
    } catch {
      // no existing process — fine
    }
    // Wait for OS to release the port after SIGKILL
    setTimeout(resolve, 2_000);
  });
}

function pollTCP(host: string, port: number, timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(1_000);
      socket.connect(port, host, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          return reject(new Error(`Timeout waiting for TCP on ${host}:${port}`));
        }
        setTimeout(attempt, 500);
      });
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          return reject(new Error(`Timeout waiting for TCP on ${host}:${port}`));
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

beforeAll(async () => {
  // Kill any leftover instance from a previous run and wait for the port to be released
  await killExistingServer();

  serverProcess = spawn(BINARY_PATH, [MODELS_DIR, '--no-tls'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Surface stderr from the binary so port-binding failures are visible
  serverProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[gRPCServerCLI] ${chunk.toString()}`);
  });
  serverProcess.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[gRPCServerCLI] ${chunk.toString()}`);
  });

  // If the binary exits immediately (e.g. port still taken, bad args), capture the error
  // so pollTCP doesn't hang for 90 s
  const earlyExitPromise = new Promise<void>((_resolve, reject) => {
    serverProcess!.once('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(
          `gRPCServerCLI exited immediately with code ${code} — port may still be in use or binary failed to start`
        ));
      }
    });
  });

  // Race: either the port becomes reachable, or the binary crashes early
  await Promise.race([
    pollTCP(HOST, PORT, 90_000),
    earlyExitPromise,
  ]);

  _client = makeClient(CLIENT_HOST);

  await new Promise<void>((resolve, reject) => {
    _client!.waitForReady(new Date(Date.now() + 30_000), (err) => {
      if (err) {
        reject(new Error(`gRPC channel did not become ready: ${err.message}`));
      } else {
        console.log(`[DT-Test] gRPC server ready at ${CLIENT_HOST}`);
        resolve();
      }
    });
  });
}, 120_000);

afterAll(async () => {
  if (_client) {
    _client.close();
    _client = null;
  }
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      serverProcess!.on('close', () => {
        console.log('[DT-Test] gRPC server stopped');
        resolve();
      });
      setTimeout(() => {
        serverProcess?.kill('SIGKILL');
        resolve();
      }, 5_000);
    });
    serverProcess = null;
  }
});
