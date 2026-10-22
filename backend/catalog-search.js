// catalog-search.js - pure helpers (no database) for finding catalogue items from typed text.
//
// Ranking, best first:
//   100  the typed text is exactly the item code
//    90  exactly the item name, or exactly one of its aliases
//    60  every typed word appears in the name (names that START with the first word rank higher)
//    40  every typed word appears somewhere in name + aliases combined
// An item where any typed word is missing is not returned at all.
//
// Search only SUGGESTS. It never decides on the user's behalf: several matches are all returned and the
// person picks one, so "hk wheel" can never silently choose between two wheel cleaners.

function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// "5KG" and "5 kg" should be the same thing, so a digit run is split from a unit that follows it.
function tokens(text) {
  return normalize(text).replace(/(\d)([a-z])/g, '$1 $2').split(' ').filter(Boolean);
}

/** items: [{ id, code, name, aliases: [string] }] -> up to `limit` matches, best first. */
function rankItems(items, query, limit = 10) {
  const q = normalize(query);
  const words = tokens(query);
  if (!words.length) return [];
  const out = [];
  for (const item of items) {
    const name = normalize(item.name);
    const aliases = (item.aliases || []).map(normalize);
    const nameTokens = tokens(item.name).join(' ');
    const everything = [nameTokens, ...aliases.map(a => tokens(a).join(' ')), normalize(item.code)].join(' ');
    let score = 0, via = 'name';
    if (normalize(item.code) === q) { score = 100; via = 'code'; }
    else if (name === q) score = 90;
    else if (aliases.includes(q)) { score = 90; via = 'alias'; }
    else if (words.every(w => nameTokens.includes(w))) score = nameTokens.startsWith(words[0]) ? 65 : 60;
    else if (words.every(w => everything.includes(w))) { score = 40; via = 'alias'; }
    if (score) out.push({ item, score, via });
  }
  out.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return out.slice(0, limit).map(o => ({ ...o.item, matched_via: o.via, score: o.score }));
}

/** "DU TYRE DRESSER 5 KG" -> "5 KG"; "HK X1 COMPOUND 500 ML" -> "500 ML"; null when no pack size is written. */
function packSizeFromName(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(KG|GM|G|ML|LTR|L)\b/i);
  if (!m) return null;
  const unit = m[2].toUpperCase();
  return `${Number(m[1])} ${unit === 'LTR' ? 'L' : unit === 'G' ? 'GM' : unit}`;
}

module.exports = { normalize, tokens, rankItems, packSizeFromName };
