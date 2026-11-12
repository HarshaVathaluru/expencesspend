const db = require('./db');
const { newId } = require('./crypto');

const DEFAULT_CATEGORIES = [
  { slug: 'food', name: 'Food & dining', kind: 'expense', color: '#F59E0B', icon_path: '/images/categories/food.svg' },
  { slug: 'groceries', name: 'Groceries', kind: 'expense', color: '#10B981', icon_path: '/images/categories/groceries.svg' },
  { slug: 'transport', name: 'Transport', kind: 'expense', color: '#0EA5E9', icon_path: '/images/categories/transport.svg' },
  { slug: 'shopping', name: 'Shopping', kind: 'expense', color: '#EC4899', icon_path: '/images/categories/shopping.svg' },
  { slug: 'rent', name: 'Rent & housing', kind: 'expense', color: '#6366F1', icon_path: '/images/categories/rent.svg' },
  { slug: 'utilities', name: 'Utilities & bills', kind: 'expense', color: '#EAB308', icon_path: '/images/categories/utilities.svg' },
  { slug: 'subscriptions', name: 'Subscriptions', kind: 'expense', color: '#8B5CF6', icon_path: '/images/categories/subscriptions.svg' },
  { slug: 'health', name: 'Health & medical', kind: 'expense', color: '#EF4444', icon_path: '/images/categories/health.svg' },
  { slug: 'education', name: 'Education', kind: 'expense', color: '#3B82F6', icon_path: '/images/categories/education.svg' },
  { slug: 'entertainment', name: 'Entertainment', kind: 'expense', color: '#A855F7', icon_path: '/images/categories/entertainment.svg' },
  { slug: 'travel', name: 'Travel', kind: 'expense', color: '#06B6D4', icon_path: '/images/categories/travel.svg' },
  { slug: 'personal_care', name: 'Personal care', kind: 'expense', color: '#F472B6', icon_path: '/images/categories/personal_care.svg' },
  { slug: 'family', name: 'Family & gifts', kind: 'expense', color: '#FB923C', icon_path: '/images/categories/family.svg' },
  { slug: 'fees', name: 'Fees & charges', kind: 'expense', color: '#94A3B8', icon_path: '/images/categories/fees.svg' },
  { slug: 'savings', name: 'Savings & investment', kind: 'savings', color: '#14B8A6', icon_path: '/images/categories/savings.svg' },
  { slug: 'income', name: 'Income & salary', kind: 'income', color: '#22C55E', icon_path: '/images/categories/income.svg' },
  { slug: 'transfer', name: 'Self transfer', kind: 'transfer', color: '#38BDF8', icon_path: '/images/categories/transfer.svg' },
  { slug: 'uncategorized', name: 'Uncategorized', kind: 'expense', color: '#64748B', icon_path: '/images/categories/uncategorized.svg' }
];

async function seedDefaultCategoriesForUser(userId) {
  const now = new Date().toISOString();
  for (const cat of DEFAULT_CATEGORIES) {
    const existing = await db.get(
      `SELECT id FROM categories WHERE user_id = ? AND slug = ?`,
      [userId, cat.slug]
    );
    if (!existing) {
      await db.run(
        `INSERT INTO categories (id, user_id, slug, name, kind, color, icon_path, is_system, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [newId('cat'), userId, cat.slug, cat.name, cat.kind, cat.color, cat.icon_path, now]
      );
    }
  }
}

const AUTO_CATEGORY_COLORS = [
  '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6',
  '#14B8A6', '#F97316', '#3B82F6', '#EF4444', '#6366F1'
];

function pickCategoryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AUTO_CATEGORY_COLORS[Math.abs(hash) % AUTO_CATEGORY_COLORS.length];
}

function slugifyCategory(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

async function ensureOrCreateCategory(userId, { name, slug = null, kind = 'expense', color = null } = {}) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (cleanName.length < 2) return null;

  const normKind = ['expense', 'income', 'transfer', 'savings'].includes(kind) ? kind : 'expense';
  const baseSlug = slugifyCategory(slug || cleanName) || 'custom';

  const existing = await db.get(
    `SELECT id, slug, name, kind, color, icon_path, is_system
     FROM categories
     WHERE user_id = ? AND (LOWER(name) = LOWER(?) OR slug = ?)
     LIMIT 1`,
    [userId, cleanName, baseSlug]
  );
  if (existing) {
    return { category: existing, created: false };
  }

  const id = newId('cat');
  const uniqueSlug = `${baseSlug}_${id.slice(-4)}`;
  const validColor = /^#[0-9A-Fa-f]{6}$/.test(color || '') ? color : pickCategoryColor(cleanName);
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO categories (id, user_id, slug, name, kind, color, icon_path, is_system, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '/images/categories/uncategorized.svg', 0, ?)`,
    [id, userId, uniqueSlug, cleanName, normKind, validColor, now]
  );

  const created = await db.get(
    `SELECT id, slug, name, kind, color, icon_path, is_system FROM categories WHERE id = ?`,
    [id]
  );
  return { category: created, created: true };
}

async function getUserCategories(userId) {
  return db.query(
    `SELECT id, slug, name, kind, color, icon_path, is_system FROM categories WHERE user_id = ? ORDER BY is_system ASC, name ASC`,
    [userId]
  );
}

module.exports = {
  DEFAULT_CATEGORIES,
  seedDefaultCategoriesForUser,
  getUserCategories,
  ensureOrCreateCategory
};
