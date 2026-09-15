import { NextResponse } from 'next/server';
import { isCronConfigured, verifyCronSecret } from '@/lib/cron-auth';
import { runTravelCron } from '@/lib/travel/cron';

export async function GET(request: Request) {
  if (!isCronConfigured()) return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  if (!verifyCronSecret(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await runTravelCron());
}
