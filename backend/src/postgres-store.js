import { prisma } from './db.js';

export async function createUser({ name, email, passwordHash }) {
  return prisma.user.create({ data: { name, email, passwordHash }, select: { id: true, name: true, email: true } });
}

export async function findOrCreateGoogleUser({ name, email, googleId }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.googleId || existing.googleId !== googleId) {
      const error = new Error('Este e-mail já possui uma conta com outro método de acesso. Entre pelo método original.');
      error.code = 'OAUTH_EMAIL_EXISTS';
      throw error;
    }
    return { id: existing.id, name: existing.name, email: existing.email };
  }
  return prisma.user.create({ data: { name, email, googleId }, select: { id: true, name: true, email: true } });
}

export async function findUserByEmail(email) {
  return prisma.user.findUnique({ where: { email } });
}

export async function findUserById(id) {
  return prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } });
}

export async function countUserContributions(userId) {
  return prisma.contribution.count({ where: { userId } });
}

export async function listContributions({ bbox, category, limit, userId }) {
  const [west, south, east, north] = bbox;
  const items = await prisma.$queryRaw`
    SELECT id, category::text AS category, ST_Y(location) AS lat, ST_X(location) AS lng,
           address, description, photos, contributor, created_at AS "createdAt",
           COALESCE(user_id = ${userId || null}::uuid, false) AS "isOwner"
    FROM contributions
    WHERE location && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
      AND ST_Intersects(location, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))
      AND (${category}::text IS NULL OR category::text = ${category})
    ORDER BY created_at DESC LIMIT ${limit + 1}`;
  const truncated = items.length > limit;
  const counts = await prisma.$queryRaw`
    SELECT category::text AS category, count(*)::int AS count
    FROM contributions
    WHERE location && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
      AND ST_Intersects(location, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))
    GROUP BY category`;
  return { items: truncated ? items.slice(0, limit) : items, counts, truncated, limit };
}

export async function createContribution({ data, contributor, userId }) {
  const rows = await prisma.$queryRaw`
    INSERT INTO contributions (category, location, address, description, photos, contributor, user_id)
    VALUES (${data.category}::"Category", ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326),
      ${data.address || null}, ${data.description || null}, ${JSON.stringify(data.photos)}::jsonb,
      ${contributor}, ${userId || null}::uuid)
    RETURNING id, category::text AS category, ST_Y(location) AS lat, ST_X(location) AS lng,
      address, description, photos, contributor, created_at AS "createdAt",
      COALESCE(user_id = ${userId || null}::uuid, false) AS "isOwner"`;
  return rows[0];
}

export async function deleteContribution({ id, userId }) {
  const rows = await prisma.$queryRaw`
    DELETE FROM contributions
    WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    RETURNING id`;
  return rows.length > 0;
}
