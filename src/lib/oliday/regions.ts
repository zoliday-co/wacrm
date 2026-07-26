// ============================================================
// City → catalog-region mapping for the Oliday package catalog.
//
// The catalog's `destination` column is region-wise (18 values);
// travellers ask city-wise ("Coorg", "Gulmarg", "Munnar"). Every
// search first resolves the ask to a region, and remembers the city
// so results that actually visit it can be preferred.
//
// Matching is whole-word in BOTH directions on lowercase
// alphanumerics: "packages for port blair please" matches the city
// "Port Blair", and the single word "kashmir" matches the region.
// ============================================================

/** The 18 regions the catalog covers, exactly as `destination` spells
 *  them. Anything else (Dubai, Bali, Maldives…) is NOT coverable —
 *  never fake it; capture the lead for a specialist instead. */
export const CATALOG_REGIONS = [
  'Rajasthan',
  'Andaman',
  'Nepal',
  'Gujarat',
  'Uttar Pradesh',
  'Kashmir',
  'Himachal',
  'Kerala',
  'Madhya Pradesh',
  'Ladakh',
  'Uttarakhand',
  'Chhattisgarh',
  'Odisha',
  'North East',
  'Tamil Nadu',
  'Karnataka',
  'Bhutan',
  'Goa',
] as const;

export type CatalogRegion = (typeof CATALOG_REGIONS)[number];

/** Region → cities/aliases travellers actually type. Slashes in the
 *  spec ("Munnar, Alleppey/Alappuzha") are split into separate aliases. */
const REGION_CITIES: Record<CatalogRegion, string[]> = {
  Kerala: [
    'Munnar',
    'Alleppey',
    'Alappuzha',
    'Kochi',
    'Cochin',
    'Thekkady',
    'Kumarakom',
    'Wayanad',
    'Kovalam',
    'Varkala',
    'Trivandrum',
    'Calicut',
    'Kozhikode',
    'Bekal',
    'Athirappilly',
    'Poovar',
    'Vagamon',
    'Guruvayur',
  ],
  Andaman: [
    'Port Blair',
    'Havelock',
    'Swaraj Dweep',
    'Neil',
    'Shaheed Dweep',
    'Radhanagar',
    'Baratang',
    'Ross Island',
    'Diglipur',
  ],
  Kashmir: [
    'Srinagar',
    'Gulmarg',
    'Pahalgam',
    'Sonmarg',
    'Doodhpathri',
    'Yusmarg',
    'Jammu',
    'Katra',
    'Vaishno Devi',
    'Dal Lake',
    'Betaab Valley',
  ],
  Himachal: [
    'Manali',
    'Shimla',
    'Dharamshala',
    'Mcleodganj',
    'Dalhousie',
    'Kasol',
    'Kullu',
    'Kufri',
    'Solang',
    'Kasauli',
    'Chail',
    'Khajjiar',
    'Palampur',
    'Bir Billing',
    'Spiti',
    'Kaza',
    'Manikaran',
    'Tirthan',
  ],
  Rajasthan: [
    'Jaipur',
    'Udaipur',
    'Jodhpur',
    'Jaisalmer',
    'Pushkar',
    'Mount Abu',
    'Bikaner',
    'Ranthambore',
    'Ajmer',
    'Chittorgarh',
    'Kumbhalgarh',
    'Sam Dunes',
  ],
  'North East': [
    'Gangtok',
    'Darjeeling',
    'Shillong',
    'Cherrapunji',
    'Kaziranga',
    'Tawang',
    'Kalimpong',
    'Pelling',
    'Lachung',
    'Lachen',
    'Namchi',
    'Ravangla',
    'Guwahati',
    'Dawki',
    'Mawlynnong',
    'Ziro',
    'Dirang',
    'Bomdila',
    'Majuli',
    'Sikkim',
    'Meghalaya',
    'Assam',
    'Arunachal',
    'Nagaland',
    'Manipur',
    'Tripura',
    'Mizoram',
  ],
  Goa: [
    'North Goa',
    'South Goa',
    'Calangute',
    'Baga',
    'Candolim',
    'Anjuna',
    'Panjim',
    'Panaji',
    'Palolem',
    'Colva',
    'Arambol',
    'Vagator',
  ],
  Uttarakhand: [
    'Nainital',
    'Mussoorie',
    'Rishikesh',
    'Haridwar',
    'Jim Corbett',
    'Auli',
    'Ranikhet',
    'Almora',
    'Kausani',
    'Bhimtal',
    'Lansdowne',
    'Chopta',
    'Dehradun',
    'Dhanaulti',
    'Char Dham',
    'Kedarnath',
    'Badrinath',
    'Gangotri',
    'Yamunotri',
    'Valley of Flowers',
    'Chakrata',
    'Munsiyari',
  ],
  Nepal: [
    'Kathmandu',
    'Pokhara',
    'Chitwan',
    'Lumbini',
    'Nagarkot',
    'Muktinath',
    'Janakpur',
  ],
  'Uttar Pradesh': [
    'Agra',
    'Varanasi',
    'Banaras',
    'Kashi',
    'Mathura',
    'Vrindavan',
    'Ayodhya',
    'Lucknow',
    'Prayagraj',
    'Fatehpur Sikri',
    'Sarnath',
    'Taj Mahal',
  ],
  'Madhya Pradesh': [
    'Khajuraho',
    'Pachmarhi',
    'Kanha',
    'Bandhavgarh',
    'Pench',
    'Gwalior',
    'Orchha',
    'Ujjain',
    'Omkareshwar',
    'Indore',
    'Bhopal',
    'Amarkantak',
    'Mandu',
    'Maheshwar',
    'Sanchi',
    'Jabalpur',
    'Bhedaghat',
  ],
  Gujarat: [
    'Rann of Kutch',
    'Kutch',
    'Bhuj',
    'Dwarka',
    'Somnath',
    'Gir',
    'Sasan Gir',
    'Ahmedabad',
    'Statue of Unity',
    'Kevadia',
    'Saputara',
    'Diu',
    'Junagadh',
    'Rajkot',
    'Vadodara',
    'Palitana',
  ],
  Ladakh: [
    'Leh',
    'Nubra',
    'Pangong',
    'Kargil',
    'Zanskar',
    'Tso Moriri',
    'Khardung La',
    'Lamayuru',
    'Turtuk',
    'Hanle',
  ],
  Karnataka: [
    'Coorg',
    'Madikeri',
    'Kodagu',
    'Chikmagalur',
    'Mysore',
    'Mysuru',
    'Hampi',
    'Gokarna',
    'Kabini',
    'Dandeli',
    'Sakleshpur',
    'Udupi',
    'Murudeshwar',
    'Badami',
    'Bandipur',
    'Bangalore',
    'Belur',
    'Halebidu',
  ],
  Bhutan: [
    'Thimphu',
    'Paro',
    'Punakha',
    'Phuentsholing',
    'Dochula',
    "Tiger's Nest",
    'Taktsang',
  ],
  Odisha: [
    'Puri',
    'Bhubaneswar',
    'Konark',
    'Chilika',
    'Gopalpur',
    'Daringbadi',
    'Cuttack',
    'Jagannath',
  ],
  'Tamil Nadu': [
    'Ooty',
    'Kodaikanal',
    'Coonoor',
    'Rameshwaram',
    'Madurai',
    'Kanyakumari',
    'Mahabalipuram',
    'Pondicherry',
    'Chennai',
    'Yercaud',
    'Thanjavur',
    'Velankanni',
    'Yelagiri',
    'Valparai',
    'Kotagiri',
  ],
  Chhattisgarh: [
    'Jagdalpur',
    'Chitrakote',
    'Bastar',
    'Raipur',
    'Mainpat',
    'Barnawapara',
    'Sirpur',
  ],
};

/** Lowercase-alphanumeric word normalisation shared by both sides of
 *  every match ("Mcleodganj", "McLeod Ganj" → "mcleodganj", "mcleod ganj"). */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Whole-word containment: does `haystack` contain `needle` as a run of
 *  whole words? Both sides normalised. */
export function containsWholeWords(haystack: string, needle: string): boolean {
  const h = ` ${normalizeForMatch(haystack)} `;
  const n = normalizeForMatch(needle);
  if (!n) return false;
  return h.includes(` ${n} `);
}

export interface ResolvedRegion {
  region: CatalogRegion;
  /** The city actually asked for, when the ask was city-level.
   *  Undefined when the ask WAS the region ("Kashmir packages"). */
  city?: string;
}

/**
 * Resolve a traveller's destination ask (free text: a city, a region,
 * or a sentence containing either) to a catalog region.
 *
 * Region names win over city names when both appear ("Kashmir or
 * Himachal?" is ambiguous anyway — first region listed wins). Returns
 * null for anything the catalog doesn't cover — the bot must then
 * capture the lead for a specialist, never fake coverage.
 */
export function resolveRegion(ask: string): ResolvedRegion | null {
  if (!ask || !ask.trim()) return null;

  // Region name mentioned directly?
  for (const region of CATALOG_REGIONS) {
    if (containsWholeWords(ask, region) || containsWholeWords(region, ask)) {
      return { region };
    }
  }

  // City mentioned? Longest alias first so "Port Blair" beats a
  // hypothetical shorter alias contained within it.
  let best: { region: CatalogRegion; city: string } | null = null;
  for (const region of CATALOG_REGIONS) {
    for (const city of REGION_CITIES[region]) {
      if (containsWholeWords(ask, city) || containsWholeWords(city, ask)) {
        if (!best || city.length > best.city.length) {
          best = { region, city };
        }
      }
    }
  }
  return best ? { region: best.region, city: best.city } : null;
}
