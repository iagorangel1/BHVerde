import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
const storageMode = process.env.STORAGE_MODE || 'file';
if (!['file', 'postgres'].includes(storageMode)) throw new Error('STORAGE_MODE must be "file" or "postgres".');
const storage = await import(storageMode === 'postgres' ? './postgres-store.js' : './file-store.js');

app.use(helmet());
const configuredFrontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const localNetworkOrigin = /^http:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$/;
app.use(cors({ origin(origin, callback) {
  if (!origin || origin === configuredFrontendOrigin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) || localNetworkOrigin.test(origin)) {
    return callback(null, true);
  }
  callback(null, false);
} }));
app.use(express.json({ limit: '10mb' }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const frontendOrigin = configuredFrontendOrigin.replace(/\/$/, '');
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/v1/auth/google/callback`;
const oauthTransactions = new Map();
const oauthCodes = new Map();

function cleanupOAuthState() {
  const now = Date.now();
  for (const [key, transaction] of oauthTransactions) if (transaction.expiresAt < now) oauthTransactions.delete(key);
  for (const [key, transaction] of oauthCodes) if (transaction.expiresAt < now) oauthCodes.delete(key);
}

function redirectOAuthResult(params) {
  const target = new URL('/', frontendOrigin);
  target.searchParams.set('google_oauth', params.status);
  if (params.code) target.searchParams.set('code', params.code);
  if (params.message) target.searchParams.set('message', params.message);
  return target.toString();
}

app.get('/api/v1/auth/google', (_req, res) => {
  if (!googleClientId || !googleClientSecret) return res.redirect(redirectOAuthResult({ status: 'error', message: 'Login Google ainda não configurado. Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no backend.' }));
  cleanupOAuthState();
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  oauthTransactions.set(createHash('sha256').update(state).digest('hex'), { nonce, expiresAt: Date.now() + 10 * 60 * 1000 });
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.search = new URLSearchParams({ client_id: googleClientId, redirect_uri: googleRedirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' }).toString();
  res.redirect(302, authorization.toString());
});

app.get('/api/v1/auth/google/callback', async (req, res, next) => {
  try {
    cleanupOAuthState();
    if (req.query.error) return res.redirect(redirectOAuthResult({ status: 'error', message: 'A autenticação Google foi cancelada.' }));
    const state = String(req.query.state || '');
    const stateKey = createHash('sha256').update(state).digest('hex');
    const transaction = oauthTransactions.get(stateKey);
    oauthTransactions.delete(stateKey);
    if (!state || !transaction || !req.query.code) return res.redirect(redirectOAuthResult({ status: 'error', message: 'Sessão OAuth inválida ou expirada. Tente novamente.' }));

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: googleRedirectUri, grant_type: 'authorization_code' })
    });
    if (!tokenResponse.ok) throw new Error('Não foi possível validar o retorno do Google. Confira o redirect URI cadastrado.');
    const tokens = await tokenResponse.json();
    if (!tokens.id_token) throw new Error('O Google não retornou um token de identidade.');
    const ticketResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`);
    if (!ticketResponse.ok) throw new Error('Token de identidade do Google inválido.');
    const identity = await ticketResponse.json();
    const expectedAudience = Buffer.from(googleClientId);
    const actualAudience = Buffer.from(String(identity.aud || ''));
    const validAudience = expectedAudience.length === actualAudience.length && timingSafeEqual(expectedAudience, actualAudience);
    if (!validAudience || identity.iss !== 'https://accounts.google.com' || Number(identity.exp) * 1000 <= Date.now() || identity.email_verified !== 'true' || identity.nonce !== transaction.nonce || !identity.sub || !identity.email) {
      throw new Error('Não foi possível confirmar a identidade da conta Google.');
    }
    const email = String(identity.email).trim().toLowerCase();
    const user = await storage.findOrCreateGoogleUser({ name: String(identity.name || email.split('@')[0]).slice(0, 60), email, googleId: identity.sub });
    const token = jwt.sign({ sub: user.id, name: user.name, email: user.email }, jwtSecret, { expiresIn: '12h' });
    const code = randomBytes(32).toString('base64url');
    oauthCodes.set(createHash('sha256').update(code).digest('hex'), { token, user, expiresAt: Date.now() + 60 * 1000 });
    res.redirect(302, redirectOAuthResult({ status: 'success', code }));
  } catch (error) {
    if (error.code === 'OAUTH_EMAIL_EXISTS') return res.redirect(redirectOAuthResult({ status: 'error', message: error.message }));
    next(error);
  }
});

app.post('/api/v1/auth/google/exchange', authLimiter, (req, res) => {
  cleanupOAuthState();
  const code = String(req.body?.code || '');
  const codeKey = createHash('sha256').update(code).digest('hex');
  const result = oauthCodes.get(codeKey);
  oauthCodes.delete(codeKey);
  if (!code || !result || result.expiresAt < Date.now()) return res.status(401).json({ error: 'Código Google inválido ou expirado. Tente novamente.' });
  res.json({ token: result.token, user: result.user });
});

const categories = ['tree', 'planting', 'care'];
const registerSchema = z.object({ name: z.string().trim().min(1).max(60), email: z.email().max(254), password: z.string().min(8).max(128) });
const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(8).max(128) });
const contributionSchema = z.object({
  category: z.enum(categories), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  address: z.string().max(500).optional().nullable(), description: z.string().max(240).optional().nullable(),
  contributor: z.string().max(60).optional().nullable(), photos: z.array(z.object({ name: z.string().max(255), dataUrl: z.string().regex(/^data:image\/jpeg;base64,/).max(2_500_000) })).max(3).default([])
});

function auth(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return next();
  try { req.user = jwt.verify(token, jwtSecret); } catch { return res.status(401).json({ error: 'Token inválido ou expirado.' }); }
  next();
}

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, storage: storageMode }));
app.get('/api/v1/config', (_req, res) => res.json({ mapTilerKey: process.env.MAPTILER_KEY || '' }));

app.post('/api/v1/auth/register', authLimiter, async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const email = data.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await storage.createUser({ name: data.name, email, passwordHash });
    res.status(201).json({ user, token: jwt.sign({ sub: user.id, name: user.name, email: user.email }, jwtSecret, { expiresIn: '12h' }) });
  } catch (error) { next(error); }
});

app.post('/api/v1/auth/login', authLimiter, async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    const user = await storage.findUserByEmail(data.email.trim().toLowerCase());
    if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    res.json({ user: { id: user.id, name: user.name, email: user.email }, token: jwt.sign({ sub: user.id, name: user.name, email: user.email }, jwtSecret, { expiresIn: '12h' }) });
  } catch (error) { next(error); }
});

app.get('/api/v1/auth/me', auth, async (req, res, next) => {
  if (!req.user?.sub) return res.status(401).json({ error: 'Autenticação necessária.' });
  try {
    const [user, contributions] = await Promise.all([
      storage.findUserById(req.user.sub), storage.countUserContributions(req.user.sub)
    ]);
    if (!user) return res.status(401).json({ error: 'Conta não encontrada.' });
    res.json({ user, contributions });
  } catch (error) { next(error); }
});

app.get('/api/v1/contributions', auth, async (req, res, next) => {
  try {
    const bbox = z.array(z.coerce.number().finite()).length(4).safeParse(String(req.query.bbox || '').split(','));
    if (!bbox.success) return res.status(400).json({ error: 'Informe bbox=west,south,east,north.' });
    const [west, south, east, north] = bbox.data;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return res.status(400).json({ error: 'Bounding box inválido.' });
    const category = req.query.category && categories.includes(String(req.query.category)) ? String(req.query.category) : null;
    if (req.query.category && !category) return res.status(400).json({ error: 'Categoria inválida.' });
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 1000));
    const result = await storage.listContributions({ bbox: [west, south, east, north], category, limit, userId: req.user?.sub || null });
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/api/v1/contributions', auth, async (req, res, next) => {
  try {
    const data = contributionSchema.parse(req.body);
    const contributor = req.user?.name || data.contributor || null;
    const item = await storage.createContribution({ data, contributor, userId: req.user?.sub });
    res.status(201).json(item);
  } catch (error) { next(error); }
});

app.delete('/api/v1/contributions/:id', auth, async (req, res, next) => {
  if (!req.user?.sub) return res.status(401).json({ error: 'Entre na sua conta para excluir uma contribuição.' });
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Identificador de contribuição inválido.' });
  try {
    const deleted = await storage.deleteContribution({ id: id.data, userId: req.user.sub });
    if (!deleted) return res.status(404).json({ error: 'Contribuição não encontrada ou não pertence a esta conta.' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos.', details: error.issues });
  if (error.code === 'EMAIL_TAKEN' || error.code === 'P2002') return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
  console.error(error);
  res.status(500).json({ error: 'Erro interno da API.' });
});

app.listen(port, () => console.log(`BH Verde API listening on http://localhost:${port} (storage: ${storageMode})`));
