/**
 * Generate human-readable task IDs like "swift-falcon-dash".
 * Three-word format: adjective-noun-verb — easy to scan at a glance.
 *
 * With 60×60×60 = 216,000 combinations, collisions are unlikely
 * for typical task volumes. Caller should check uniqueness and retry.
 */

const adjectives = [
  'bold', 'calm', 'cold', 'cool', 'dark', 'deep', 'dry', 'dull',
  'fast', 'fine', 'firm', 'flat', 'free', 'full', 'glad', 'gold',
  'gray', 'hard', 'high', 'keen', 'kind', 'late', 'lean', 'live',
  'long', 'loud', 'low', 'mild', 'neat', 'new', 'odd', 'pale',
  'past', 'pink', 'pure', 'rare', 'raw', 'red', 'rich', 'ripe',
  'safe', 'slim', 'slow', 'soft', 'sure', 'tall', 'thin', 'tiny',
  'true', 'vast', 'warm', 'weak', 'wide', 'wild', 'wise', 'worn',
  'blue', 'bright', 'sharp', 'swift',
];

const nouns = [
  'ant', 'arc', 'ash', 'bay', 'bee', 'bolt', 'bone', 'bud',
  'cape', 'cave', 'clay', 'coal', 'cone', 'crab', 'crow', 'dawn',
  'deer', 'dew', 'dove', 'drum', 'dusk', 'dust', 'elm', 'fern',
  'fig', 'fin', 'flint', 'fog', 'fox', 'frog', 'gale', 'gem',
  'glen', 'grain', 'hawk', 'haze', 'helm', 'hive', 'jade', 'jay',
  'kelp', 'knot', 'lark', 'leaf', 'lime', 'lynx', 'mist', 'moth',
  'nest', 'oak', 'owl', 'peak', 'pine', 'pond', 'reef', 'root',
  'sage', 'seal', 'shard', 'vine',
];

const verbs = [
  'bolt', 'burn', 'buzz', 'call', 'cast', 'chip', 'chop', 'clap',
  'coil', 'cook', 'cull', 'curl', 'dash', 'deal', 'dip', 'dock',
  'drag', 'draw', 'drip', 'drop', 'dump', 'fade', 'fall', 'fend',
  'fill', 'fire', 'fish', 'fist', 'flag', 'flip', 'flow', 'fold',
  'fuse', 'grab', 'grit', 'grow', 'gulp', 'hang', 'hike', 'hook',
  'hum', 'hunt', 'hurl', 'jolt', 'jump', 'knit', 'lash', 'leap',
  'lift', 'lock', 'loom', 'lure', 'mend', 'mine', 'mold', 'nail',
  'pack', 'pave', 'pull', 'push',
];

function pick(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/** Generate a single candidate ID. */
export function generateWordId(): string {
  return `${pick(adjectives)}-${pick(nouns)}-${pick(verbs)}`;
}

/**
 * Generate a unique word ID, checking against an `exists` predicate.
 * Falls back to appending a numeric suffix after maxTries.
 */
export function generateUniqueWordId(exists: (id: string) => boolean, maxTries = 10): string {
  for (let i = 0; i < maxTries; i++) {
    const id = generateWordId();
    if (!exists(id)) return id;
  }
  // Fallback: append timestamp fragment to guarantee uniqueness
  return `${generateWordId()}-${Date.now() % 100000}`;
}
