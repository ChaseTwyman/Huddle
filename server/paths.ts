import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA = path.join(ROOT, 'data');
export const dataPath = (...parts: string[]) => path.join(DATA, ...parts);
