/**
 * Catalog smoke test — verifies grounding without touching WhatsApp.
 *
 * Exercises the bot's two retrieval tools against the REAL Supabase
 * catalog and prints the top matches for a sample trip, then fetches
 * the first result in full. If this passes, every price/hotel/route
 * the bot can state is coming from live rows.
 *
 * Run (reads OLIDAY_CATALOG_* from .env.local):
 *   npx tsx --env-file=.env.local scripts/smoke-catalog.ts
 *   npx tsx --env-file=.env.local scripts/smoke-catalog.ts "Coorg" 5 4 1
 *                                                  (destination nights adults children)
 */
import { searchPackages } from '../src/lib/oliday/search';
import { getPackage } from '../src/lib/oliday/package';
import { resolveRegion } from '../src/lib/oliday/regions';
import { perPersonLine } from '../src/lib/oliday/format';

async function main() {
  const [, , destArg, nightsArg, adultsArg, childrenArg] = process.argv;
  const destination = destArg || 'Kashmir';
  const nights = Number(nightsArg || 5);
  const adults = Number(adultsArg || 2);
  const children = Number(childrenArg || 0);
  const pax = adults + children;

  if (!process.env.OLIDAY_CATALOG_SUPABASE_URL) {
    console.error(
      'OLIDAY_CATALOG_SUPABASE_URL / _ANON_KEY not set. Run with:\n' +
        '  npx tsx --env-file=.env.local scripts/smoke-catalog.ts'
    );
    process.exit(1);
  }

  const resolved = resolveRegion(destination);
  console.log(
    `\nAsk: ${destination} · ${nights}N · ${adults} adults + ${children} kids`
  );
  console.log(
    resolved
      ? `Resolved region: ${resolved.region}${resolved.city ? ` (city: ${resolved.city})` : ''}`
      : 'Region: NOT COVERED — the bot would capture the lead for a specialist'
  );
  if (!resolved) process.exit(0);

  const t0 = Date.now();
  const result = await searchPackages({
    destination,
    nights,
    adults,
    children,
  });
  console.log(
    `\nsearch_packages → ${result.packages.length} matches in ${Date.now() - t0}ms` +
      (result.city
        ? result.cityMatched
          ? ` (filtered to packages visiting ${result.city})`
          : ` (no package visits ${result.city}; showing ${result.region})`
        : '')
  );

  for (const [i, p] of result.packages.entries()) {
    console.log(`\n${i + 1}. *${p.name} — ${p.nights}N/${p.days}D*`);
    if (p.route) console.log(`   ${p.route}`);
    if (p.hotels) console.log(`   ${p.hotels}`);
    console.log(
      `   ${p.meal_plan ?? 'meals n/a'} · ${p.vehicle ?? 'vehicle n/a'}${p.vehicle_seats ? ` (${p.vehicle_seats} seats)` : ''}`
    );
    console.log(
      `   ${p.per_person ? perPersonLine(p.per_person, pax) : `from ₹${p.starting_price} (starting price)`}`
    );
    console.log(`   ids: promo_id=${p.promo_id} h_id=${p.h_id}`);
  }

  if (result.packages.length === 0) {
    console.log('No packages — check the catalog view/RLS.');
    process.exit(1);
  }

  const first = result.packages[0];
  const t1 = Date.now();
  const detail = await getPackage(first.promo_id, first.h_id);
  if (!detail) {
    console.error(
      `\nget_package(${first.promo_id}, ${first.h_id}) → NOT FOUND`
    );
    process.exit(1);
  }
  const itinerary = Array.isArray(detail.itinerary) ? detail.itinerary : [];
  const inclusions = Array.isArray(detail.inclusions) ? detail.inclusions : [];
  console.log(
    `\nget_package(${first.promo_id}, ${first.h_id}) in ${Date.now() - t1}ms:` +
      ` ${itinerary.length} itinerary days, ${inclusions.length} inclusions`
  );
  const day1 = itinerary[0] as { day?: string; title?: string } | undefined;
  if (day1) console.log(`  ${day1.day}: ${day1.title}`);
  for (const forbidden of ['view_details_url', 'supplier_id', 'product_code']) {
    if (forbidden in detail) {
      console.error(`  LEAK: ${forbidden} present in get_package output`);
      process.exit(1);
    }
  }
  console.log('  supplier fields stripped ✓');
  console.log('\nSmoke test passed.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
