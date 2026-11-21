import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const dataFile = process.env.DATA_FILE || join(dataDirectory, 'bhverde.json');
let state;
let initialization;
let writeQueue = Promise.resolve();

async function initialize() {
  if (state) return;
  if (!initialization) {
    initialization = (async () => {
      await mkdir(dirname(dataFile), { recursive: true, mode: 0o700 });
      try {
        state = JSON.parse(await readFile(dataFile, 'utf8'));
        if (!Array.isArray(state.users) || !Array.isArray(state.contributions)) throw new Error('Invalid local store format');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { users: [], contributions: [] };
        await writeFile(dataFile, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      }
    })();
  }
  await initialization;
}

async function update(mutator) {
  await initialize();
  const operation = writeQueue.then(async () => {
    const next = structuredClone(state);
    const result = mutator(next);
    const temporary = `${dataFile}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, dataFile);
    state = next;
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

async function snapshot() {
  await initialize();
  await writeQueue;
  return state;
}

export async function createUser({ name, email, passwordHash }) {
  return update((data) => {
    if (data.users.some((user) => user.email === email)) {
      const error = new Error('Email already registered');
      error.code = 'EMAIL_TAKEN';
      throw error;
    }
    const user = { id: randomUUID(), name, email, passwordHash: passwordHash || null, createdAt: new Date().toISOString() };
    data.users.push(user);
    return { id: user.id, name: user.name, email: user.email };
  });
}

export async function findOrCreateGoogleUser({ name, email, googleId }) {
  return update((data) => {
    const existing = data.users.find((user) => user.email === email);
    if (existing) {
      if (existing.googleId !== googleId) {
        const error = new Error('Este e-mail já possui uma conta com senha. Entre com e-mail e senha para evitar vinculação não autorizada.');
        error.code = 'OAUTH_EMAIL_EXISTS';
        throw error;
      }
      return { id: existing.id, name: existing.name, email: existing.email };
    }
    const user = { id: randomUUID(), name, email, passwordHash: null, googleId, createdAt: new Date().toISOString() };
    data.users.push(user);
    return { id: user.id, name: user.name, email: user.email };
  });
}

export async function findUserByEmail(email) {
  const data = await snapshot();
  return data.users.find((user) => user.email === email) || null;
}

export async function findUserById(id) {
  const data = await snapshot();
  const user = data.users.find((entry) => entry.id === id);
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

export async function countUserContributions(userId) {
  const data = await snapshot();
  return data.contributions.filter((item) => item.userId === userId).length;
}

export async function listContributions({ bbox, category, limit, userId }) {
  const data = await snapshot();
  const [west, south, east, north] = bbox;
  const inView = data.contributions.filter((item) => item.lng >= west && item.lng <= east && item.lat >= south && item.lat <= north);
  const matching = category ? inView.filter((item) => item.category === category) : inView;
  const counts = ['tree', 'planting', 'care']
    .map((value) => ({ category: value, count: inView.filter((item) => item.category === value).length }))
    .filter((entry) => entry.count > 0);
  const ordered = [...matching].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const items = ordered.slice(0, limit).map(({ userId: ownerId, ...item }) => ({ ...item, isOwner: Boolean(userId && ownerId === userId) }));
  return { items, counts, truncated: ordered.length > limit, limit };
}

export async function deleteContribution({ id, userId }) {
  return update((data) => {
    const index = data.contributions.findIndex((item) => item.id === id && item.userId === userId);
    if (index === -1) return false;
    data.contributions.splice(index, 1);
    return true;
  });
}

export async function createContribution({ data: input, contributor, userId }) {
  return update((data) => {
    const item = {
      id: randomUUID(), category: input.category, lat: input.lat, lng: input.lng,
      address: input.address || null, description: input.description || null,
      photos: input.photos || [], contributor, userId: userId || null,
      createdAt: new Date().toISOString()
    };
    data.contributions.push(item);
    const { userId: ownerId, ...publicItem } = item;
    return { ...publicItem, isOwner: Boolean(userId && ownerId === userId) };
  });
}
