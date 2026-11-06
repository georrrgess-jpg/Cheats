/** Map Gamma tag labels to a small set of top-level categories. Deterministic, first match wins. */
const ORDER: [string, RegExp][] = [
  ['Sports', /^(sports|nba|nfl|mlb|nhl|soccer|football|tennis|ufc|mma|golf|f1|formula 1|cricket|esports|boxing|ncaa|epl|champions league|basketball|baseball|hockey)$/i],
  ['Crypto', /^(crypto|bitcoin|ethereum|solana|xrp|crypto prices|memecoins|airdrops|stablecoins|defi)$/i],
  ['Geopolitics', /^(geopolitics|world|middle east|ukraine|russia|china|israel|iran|war|foreign policy|world elections|global elections)$/i],
  ['Politics', /^(politics|elections|us election|us politics|trump|midterms|congress|senate|house elections|us election 2028|courts|scotus)$/i],
  ['Economics', /^(economy|economics|fed|fed rates|inflation|interest rates|gdp|jobs|recession|macro)$/i],
  ['Finance', /^(finance|stocks|business|equities|ipos|earnings|commodities|forex|indices)$/i],
  ['Tech', /^(tech|technology|ai|science|openai|big tech|space)$/i],
  ['Culture', /^(culture|pop culture|movies|music|entertainment|awards|tv|celebrities|oscars|grammys|youtube|tweet markets|social media)$/i],
  ['Weather', /^(weather|climate|temperature|hurricanes)$/i],
  ['Mentions', /^(mentions|mention markets)$/i],
];

export function categorize(tags: string[]): string {
  for (const [cat, re] of ORDER) if (tags.some((t) => re.test(t.trim()))) return cat;
  return 'Other';
}

export const CATEGORIES = [...ORDER.map(([c]) => c), 'Other'];
