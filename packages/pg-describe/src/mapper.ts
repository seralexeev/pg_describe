#!/usr/bin/env node
import * as path from 'node:path';

import { compileSqlFile, DiagnosticCode } from './codegen.ts';
import { type Config, type Options, resolveConfig, schemaFiles } from './config.ts';
import { Describer } from './database.ts';

const PROTOCOL_VERSION = 1;

type Project = { config: Config; describer: Promise<Describer> };

const projects = new Map<string, Project>();

const project = (handle: string) => {
  const found = projects.get(handle);
  if (found == null) {
    throw new Error(`Unknown project handle ${handle}`);
  }
  return found;
};

const handlers: Record<string, (params: any) => Promise<unknown>> = {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, positionEncoding: 'utf-16', diagnosticSource: 'pg-describe' };
  },

  async openProject(params: { configFileName: string; projectHandle: string; options?: Options }) {
    const root = params.configFileName === '' ? process.cwd() : path.dirname(params.configFileName);
    const config = resolveConfig(root, params.options);
    const describer = Describer.open(config);
    describer.catch(() => undefined);
    projects.set(params.projectHandle, { config, describer });
    return {
      configIdentity: await describer.then(
        (d) => d.identity,
        (error: Error) => `unavailable:${error.message}`,
      ),
      watchedFiles: schemaFiles(config),
    };
  },

  async closeProject(params: { projectHandle: string }) {
    const closing = projects.get(params.projectHandle);
    projects.delete(params.projectHandle);
    await closing?.describer.then((d) => d.close()).catch(() => undefined);
    return null;
  },

  async transform(params: { fileName: string; content: string; projectHandle: string }) {
    const { config, describer } = project(params.projectHandle);
    const opened = await describer.catch((error: Error) => error);
    if (opened instanceof Error) {
      return {
        text: 'export {};\n',
        extension: '.ts',
        diagnostics: [{ messageText: opened.message, start: 0, length: 0, code: DiagnosticCode.Database }],
      };
    }
    const compiled = await compileSqlFile(config, opened, params.content);
    return {
      text: compiled.declaration,
      extension: '.ts',
      mappings: compiled.mappings,
      diagnostics: compiled.diagnostics.map(({ message, code, start, length }) => ({
        messageText: message,
        code,
        start,
        length,
      })),
    };
  },
};

type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown };

const send = (message: object) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};

const dispatch = async ({ id, method, params }: Message) => {
  const handler = method == null ? undefined : handlers[method];
  if (id == null) {
    return;
  }
  if (handler == null) {
    send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    return;
  }
  try {
    send({ id, result: await handler(params) });
  } catch (error) {
    send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
};

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) {
      return;
    }
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8')) as Message;
    buffer = buffer.subarray(start + length);
    void dispatch(message);
  }
});

process.stdin.on('end', async () => {
  await Promise.all([...projects.keys()].map((handle) => handlers.closeProject!({ projectHandle: handle })));
  process.exit(0);
});
