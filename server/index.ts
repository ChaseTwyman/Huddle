import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8787);
const app = express();
app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
createServer(app).listen(port, () => console.log(`[huddle] server on :${port}`));
