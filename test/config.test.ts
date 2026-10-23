// Settings come from config.yaml in the working directory: mistakes stop the server with the key named, and
// production refuses to start without the file or its required keys.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CONFIG = resolve('src/config.ts');
// The TypeScript loader, found from this repository rather than from the temporary folder the process runs in.
const TSX = import.meta.resolve('tsx');

// Loads the settings in a fresh process, in a folder holding this config.yaml (or none).
async function load(yaml: string | null, nodeEnv = 'development'){
  const dir = mkdtempSync(join(tmpdir(), 'folio-config-'));
  if (yaml !== null) writeFileSync(join(dir, 'config.yaml'), yaml);
  const code = `const { config } = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify(config));`;
  try {
    const { stdout } = await run(process.execPath, ['--import', TSX, '--input-type=module', '-e', code], { cwd: dir, env: { ...process.env, NODE_ENV: nodeEnv } });
    return { config: JSON.parse(stdout) };
  } catch (e){ return { error: (e as { stderr: string }).stderr }; }
}

describe('config.yaml', () => {
  it('maps the keys onto the settings, with development defaults for the rest', async () => {
    const { config } = await load('site_url: http://203.0.113.10:8080/\ncookie_secure: false\nmock_payments: true\ns3:\n  bucket: folio\n  force_path_style: false\nsmtp:\n  from: Folio <a@b.c>\n');
    expect(config).toMatchObject({
      siteUrl: 'http://203.0.113.10:8080', siteOrigins: ['http://203.0.113.10:8080'], cookieSecure: false, mockPayments: true, devTools: false,
      s3: { bucket: 'folio', forcePathStyle: false, endpoint: 'http://folio-minio:9000' }, mailFrom: 'Folio <a@b.c>', smtpUrl: 'smtp://folio-mailpit:1025', port: 47110
    });
  });

  it('without a file, development runs on its defaults', async () => {
    expect((await load(null)).config).toMatchObject({ siteUrl: 'http://localhost:47120', mockPayments: false, trustProxy: false });
  });

  it('names an unknown key or a wrong value', async () => {
    expect((await load('cookie_secur: true\n')).error).toContain('cookie_secur');
    expect((await load('mock_payments: "yes"\n')).error).toContain('mock_payments');
    expect((await load('s3:\n  bucket: [1, 2]\n')).error).toContain('s3.bucket');
  });

  it('in production, needs the file and its required keys', async () => {
    expect((await load(null, 'production')).error).toContain('config.yaml not found');
    expect((await load('site_url: https://folio.example.com\n', 'production')).error)
      .toContain('required in production: secret_key, s3.bucket, s3.access_key_id, s3.secret_access_key, smtp.url, smtp.from');
    const complete = 'secret_key: k\ns3:\n  bucket: b\n  access_key_id: a\n  secret_access_key: s\nsmtp:\n  url: smtp://x\n  from: F <f@x.y>\n';
    expect((await load(`${complete}dev_tools: true\n`, 'production')).error).toContain('dev_tools must not be enabled in production');
    expect((await load(complete, 'production')).config).toMatchObject({ secretKey: 'k', s3: { bucket: 'b' } });
  });
});
