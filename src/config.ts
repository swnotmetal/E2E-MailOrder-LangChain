// One place that decides whether the process is allowed to start.
//
// Reading `process.env` at the point of use means a missing or malformed value surfaces deep inside
// a request, after side effects have begun. Every entry point loads the files once, then validates
// what it needs here, so a bad config fails before anything is written.
import { resolve } from 'node:path';
import { z } from 'zod';

export function loadEnvFiles(files: string[] = ['.env.erp', '.env']): void {
  for (const file of files) {
    try {
      process.loadEnvFile(resolve(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// `api_key:api_secret` exactly. A stray space or a pasted newline produces a header that fails
// every request with an opaque 401, so it is rejected here instead.
const Token = z.string().regex(/^[^\s:]+:[^\s:]+$/, 'expected api_key:api_secret with no spaces and exactly one colon');

const ErpConfig = z.object({
  ERP_URL: z.string().url().default('http://127.0.0.1:8080'),
  ERP_COMPANY: z.string().min(1).default('Nordic Parts Demo'),
  token: Token,
});

const ModelConfig = z.object({ GOOGLE_API_KEY: z.string().min(20) });

function fail(code: string, error: z.ZodError): never {
  const issues = error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw Error(`${code}: ${issues}`);
}

export type ErpConfigValue = { base: string; company: string; token: string };

export function erpConfig(env: NodeJS.ProcessEnv = process.env): ErpConfigValue {
  const token = env.ERP_INBOX_TOKEN ?? env.ERP_TOKEN;
  const parsed = ErpConfig.safeParse({ ERP_URL: env.ERP_URL, ERP_COMPANY: env.ERP_COMPANY, token });
  if (!parsed.success) {
    const hint = token === undefined
      ? ' (set ERP_INBOX_TOKEN in .env.erp; regenerate with frappe.core.doctype.user.user.generate_keys)'
      : '';
    fail(`ERP_CONFIG_INVALID${hint}`, parsed.error);
  }
  return { base: parsed.data.ERP_URL, company: parsed.data.ERP_COMPANY, token: parsed.data.token };
}

export type ModelConfigValue = { apiKey: string };

export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfigValue {
  const parsed = ModelConfig.safeParse({ GOOGLE_API_KEY: env.GOOGLE_API_KEY });
  if (!parsed.success) fail('MODEL_CONFIG_INVALID (set GOOGLE_API_KEY in .env)', parsed.error);
  return { apiKey: parsed.data.GOOGLE_API_KEY };
}
