import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataPath } from '../paths';

export const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

/** Memory + disk cache for successful LLM outputs (data/cache/llm/<sha1>.json). */
export class LlmCache {
  private mem = new Map<string, unknown>();
  private dir = dataPath('cache', 'llm');
  constructor(private enabled: boolean) {}

  key(parts: { task: string; model: string; system: string; user: string; images?: string[] }) {
    const img = parts.images?.length ? sha1(parts.images.join('|')) : '';
    return sha1([parts.task, parts.model, parts.system, parts.user, img].join('\u0000'));
  }

  get(key: string): unknown | undefined {
    if (!this.enabled) return undefined;
    if (this.mem.has(key)) return this.mem.get(key);
    const f = path.join(this.dir, `${key}.json`);
    try {
      if (fs.existsSync(f)) {
        const v = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.mem.set(key, v);
        return v;
      }
    } catch { /* corrupt cache entry: ignore */ }
    return undefined;
  }

  set(key: string, value: unknown) {
    if (!this.enabled) return;
    this.mem.set(key, value);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(value));
    } catch { /* disk cache is best effort */ }
  }
}
