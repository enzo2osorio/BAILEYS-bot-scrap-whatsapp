'use strict';

// Estas funciones deberían existir ya en tus utils; ajusta nombres si difieren
// Deben devolver arrays: [{ id, name, ... }]
const { fetchCategorias } = require('./fetch-categorias');      // ajusta ruta/nombre
const { fetchSubcategorias } = require('./fetch-subcategorias'); // ajusta ruta/nombre
const { fetchDestinatarios } = require('./fetch-destinatarios'); // ajusta ruta/nombre

// Cache simple en memoria
let taxonomyCache = {
  categorias: new Map(),      // id -> { id, name }
  subcategorias: new Map(),   // id -> { id, name, categoria_id }
  loadedAt: 0
};

const TAXONOMY_TTL_MS = 5 * 60 * 1000; // 5 min

async function ensureTaxonomyFresh() {
  const now = Date.now();
  if (now - taxonomyCache.loadedAt < TAXONOMY_TTL_MS &&
      taxonomyCache.categorias.size &&
      taxonomyCache.subcategorias.size) return taxonomyCache;

  const [cats, subs] = await Promise.all([
    fetchCategorias(),
    fetchSubcategorias()
  ]);

  taxonomyCache.categorias = new Map(cats.map(c => [c.id, c]));
  taxonomyCache.subcategorias = new Map(subs.map(s => [s.id, s]));
  taxonomyCache.loadedAt = now;
  return taxonomyCache;
}

/**
 * Agrupa destinatarios por categoría y subcategoría.
 * destinatarios: [{ id, name, category_id, subcategory_id, ... }]
 */
function groupDestinatarios(destinatarios, categoriasMap, subcategoriasMap) {
  const grouped = new Map(); // catId -> { cat, subs: Map(subId -> { sub, items: [] }), uncategorized: [] }

  for (const d of destinatarios) {
    const cat = categoriasMap.get(d.category_id) || { id: d.category_id, name: 'Sin categoría' };
    const sub = subcategoriasMap.get(d.subcategory_id) || null;

    if (!grouped.has(cat.id)) {
      grouped.set(cat.id, { cat, subs: new Map(), itemsNoSub: [] });
    }
    const catEntry = grouped.get(cat.id);

    if (sub) {
      if (!catEntry.subs.has(sub.id)) {
        catEntry.subs.set(sub.id, { sub, items: [] });
      }
      catEntry.subs.get(sub.id).items.push(d);
    } else {
      catEntry.itemsNoSub.push(d);
    }
  }
  return grouped;
}

/**
 * Formatea el agrupamiento en bloques de texto. Genera códigos para selección.
 * Devuelve: { blocks: [string], indexMap: Map(code -> destinatario) }
 */
function formatGrouped(grouped, {
  includeIds = false,
  codePrefix = 'D',
  maxCharsPerBlock = 3500
} = {}) {
  const blocks = [];
  const indexMap = new Map();
  let current = [];
  let currentLen = 0;
  let counter = 1;

  const pushLine = (line) => {
    const toAdd = line + '\n';
    if (currentLen + toAdd.length > maxCharsPerBlock) {
      blocks.push(current.join('').trim());
      current = [];
      currentLen = 0;
    }
    current.push(toAdd);
    currentLen += toAdd.length;
  };

  for (const { cat, subs, itemsNoSub } of grouped.values()) {
    pushLine(`📂 *${cat.name}*`);
    // Items sin subcategoría
    for (const item of itemsNoSub) {
      const code = `${codePrefix}${counter}`;
      indexMap.set(code, item);
      pushLine(`  ${code}. ${item.name}${includeIds ? ` (id:${item.id})` : ''}`);
      counter++;
    }
    // Subcategorías
    for (const { sub, items } of subs.values()) {
      pushLine(`  🗂️ _${sub.name}_`);
      for (const item of items) {
        const code = `${codePrefix}${counter}`;
        indexMap.set(code, item);
        pushLine(`    ${code}. ${item.name}${includeIds ? ` (id:${item.id})` : ''}`);
        counter++;
      }
    }
    pushLine(''); // separación
  }
  if (currentLen) blocks.push(current.join('').trim());
  return { blocks, indexMap };
}

/**
 * Función de alto nivel: obtiene (o recibe) destinatarios, agrupa y formatea.
 */
async function buildCategorizedDestinatariosMessage(destinatariosInput, opts = {}) {
  await ensureTaxonomyFresh();
  const destinatarios = destinatariosInput || await fetchDestinatarios(); // si no se pasan, los carga
  const grouped = groupDestinatarios(destinatarios, taxonomyCache.categorias, taxonomyCache.subcategorias);
  return formatGrouped(grouped, opts);
}

module.exports = {
  buildCategorizedDestinatariosMessage
};