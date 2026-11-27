'use strict';

const LIMITS = {
  title: 120,
  description: 1000,
  currency: 8,
  sectionName: 120,
  sectionDescription: 500,
  itemName: 120,
  itemDescription: 1000,
  price: 40,
  tag: 30,
  tagsPerItem: 10,
  sections: 100,
  itemsPerSection: 300,
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  // Collapse Windows line endings and trim; keep inner newlines for descriptions.
  const clean = value.replace(/\r\n?/g, '\n').trim();
  if (required && !clean) throw new ValidationError(`${field} is required`);
  if (clean.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return clean;
}

function singleLine(value, field, max, opts) {
  return text(value, field, max, opts).replace(/\s*\n\s*/g, ' ');
}

function tags(value, field) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(',');
  else if (value === undefined || value === null) list = [];
  else throw new ValidationError(`${field} must be a list`);

  const seen = new Set();
  const out = [];
  for (const raw of list) {
    // Commas separate tags in storage, so they can't appear inside one.
    const tag = singleLine(raw, field, LIMITS.tag).replace(/,/g, ' ').trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  if (out.length > LIMITS.tagsPerItem) {
    throw new ValidationError(`${field} can have at most ${LIMITS.tagsPerItem} tags`);
  }
  return out;
}

/** Validates the menu title used when creating a new, empty menu. */
function validateTitle(title) {
  return singleLine(title, 'Menu title', LIMITS.title, { required: true });
}

/** Validates and normalizes a full menu document sent by the editor. */
function validateMenu(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Menu data is missing');
  }
  const sections = input.sections ?? [];
  if (!Array.isArray(sections)) throw new ValidationError('Sections must be a list');
  if (sections.length > LIMITS.sections) {
    throw new ValidationError(`A menu can have at most ${LIMITS.sections} sections`);
  }

  return {
    title: validateTitle(input.title),
    description: text(input.description, 'Menu description', LIMITS.description),
    currency: singleLine(input.currency, 'Currency', LIMITS.currency),
    published: input.published !== false,
    sections: sections.map((section, s) => {
      const where = `Section ${s + 1}`;
      if (!section || typeof section !== 'object') throw new ValidationError(`${where} is invalid`);
      const items = section.items ?? [];
      if (!Array.isArray(items)) throw new ValidationError(`${where}: items must be a list`);
      if (items.length > LIMITS.itemsPerSection) {
        throw new ValidationError(`${where} can have at most ${LIMITS.itemsPerSection} items`);
      }
      return {
        name: singleLine(section.name, `${where} name`, LIMITS.sectionName, { required: true }),
        description: text(section.description, `${where} description`, LIMITS.sectionDescription),
        items: items.map((item, i) => {
          const itemWhere = `${where}, item ${i + 1}`;
          if (!item || typeof item !== 'object') throw new ValidationError(`${itemWhere} is invalid`);
          return {
            name: singleLine(item.name, `${itemWhere} name`, LIMITS.itemName, { required: true }),
            description: text(item.description, `${itemWhere} description`, LIMITS.itemDescription),
            price: singleLine(item.price, `${itemWhere} price`, LIMITS.price),
            tags: tags(item.tags, `${itemWhere} tags`),
            available: item.available !== false,
          };
        }),
      };
    }),
  };
}

/**
 * Plain numbers get the menu's currency symbol ("12.5" -> "$12.50");
 * anything else ("Market price", "8 / 12") is shown exactly as typed.
 */
function formatPrice(price, currency) {
  if (!price) return '';
  if (/^\d+(\.\d{1,2})?$/.test(price)) {
    const [whole, cents] = price.split('.');
    const amount = cents === undefined ? whole : `${whole}.${cents.padEnd(2, '0')}`;
    return `${currency}${amount}`;
  }
  return price;
}

module.exports = { validateMenu, validateTitle, formatPrice, ValidationError, LIMITS };
