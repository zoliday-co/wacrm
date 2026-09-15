'use client';

import Image from 'next/image';
import type { PublicItineraryView } from '@/lib/travel/itinerary-sharing';

export function BrandedItinerary({ view, downloadUrl }: { view: PublicItineraryView; downloadUrl: string }) {
  const itinerary = view.itinerary;
  const extras = itinerary.extras ?? {};
  const shareText = `Your Oliday itinerary: ${itinerary.title}`;
  const share = () => {
    const url = window.location.href;
    if (navigator.share) void navigator.share({ title: itinerary.title, text: shareText, url });
    else window.open(`https://wa.me/?text=${encodeURIComponent(`${shareText}\n${url}`)}`, '_blank', 'noopener,noreferrer');
  };
  return (
    <main className="min-h-screen bg-[#f5f1e8] text-slate-900">
      <section className="relative overflow-hidden bg-[#073f39] px-5 pb-20 pt-8 text-white sm:px-10">
        <div className="absolute -right-16 -top-20 h-72 w-72 rounded-full bg-[#0d8b76]/30" />
        <div className="relative mx-auto max-w-5xl">
          <div className="flex items-start justify-between gap-6">
            <Image src="/oliday_logo.png" alt="Oliday" width={180} height={60} className="h-auto w-36 object-contain brightness-0 invert sm:w-44" priority />
            <p className="rounded-full border border-white/25 px-3 py-1 text-xs font-semibold tracking-widest text-emerald-100">ITINERARY V{itinerary.version}</p>
          </div>
          <div className="mt-16 max-w-3xl">
            <p className="text-xs font-bold tracking-[0.28em] text-amber-200">YOUR PERSONALISED JOURNEY</p>
            <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{itinerary.title}</h1>
            {itinerary.summary ? <p className="mt-5 max-w-2xl text-lg leading-8 text-emerald-50/85">{itinerary.summary}</p> : null}
            <p className="mt-8 text-sm font-medium text-emerald-100">Prepared {view.traveller_name ? `for ${view.traveller_name}` : 'especially for you'}</p>
          </div>
        </div>
      </section>

      <div className="relative mx-auto -mt-10 max-w-5xl space-y-8 px-4 pb-16 sm:px-8">
        <section className="grid overflow-hidden rounded-3xl bg-white shadow-xl sm:grid-cols-[1fr_auto]">
          <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Destination" value={view.destination ?? 'To be confirmed'} />
            <Fact label="Travel" value={view.travel_start_date ? `${view.travel_start_date}${view.travel_end_date ? ` – ${view.travel_end_date}` : ''}` : view.travel_month ?? 'Flexible'} />
            <Fact label="Duration" value={`${view.nights ?? '—'} nights / ${view.days ?? '—'} days`} />
            <Fact label="Travellers" value={`${view.adults} adults${view.children ? ` + ${view.children} children` : ''}`} />
            <Fact label="Stay" value={[view.hotel_category, view.room_configuration, view.meal_plan].filter(Boolean).join(' · ') || 'To be confirmed'} />
            <Fact label="Vehicle" value={view.vehicle_type ?? 'To be confirmed'} />
          </div>
          <div className="hidden items-end bg-amber-50 px-5 pt-5 sm:flex"><Image src="/oli.png" alt="Oli, your Oliday travel companion" width={150} height={190} className="h-40 w-auto object-contain" /></div>
        </section>

        <section>
          <div className="mb-5 flex items-end justify-between"><div><p className="text-xs font-bold tracking-[0.22em] text-[#0d8b76]">DAY BY DAY</p><h2 className="mt-1 text-3xl font-black">Your journey</h2></div><span className="text-sm text-slate-500">{itinerary.days?.length ?? 0} memorable days</span></div>
          <div className="space-y-4">{(itinerary.days ?? []).map((day) => <article key={day.id ?? day.day_number} className="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid-cols-[120px_1fr]"><div className="bg-[#0d8b76] p-5 text-white"><p className="text-xs font-bold tracking-widest text-emerald-100">DAY</p><p className="mt-1 text-4xl font-black">{day.day_number}</p>{day.date ? <p className="mt-3 text-xs text-emerald-50">{formatDate(day.date)}</p> : null}</div><div className="space-y-4 p-6"><h3 className="text-xl font-bold">{day.title}</h3>{day.description ? <p className="whitespace-pre-wrap leading-7 text-slate-600">{day.description}</p> : null}{day.activities?.length ? <div className="flex flex-wrap gap-2">{day.activities.map((activity) => <span key={activity} className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-900">{activity}</span>)}</div> : null}<div className="grid gap-2 border-t border-slate-100 pt-4 text-sm sm:grid-cols-3">{day.hotel ? <Detail label="Stay" value={day.hotel} /> : null}{day.meals ? <Detail label="Meals" value={day.meals} /> : null}{day.transport ? <Detail label="Transport" value={day.transport} /> : null}</div></div></article>)}</div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">{text(extras.inclusions) ? <Essential title="What’s included" body={text(extras.inclusions)!} /> : null}{text(extras.exclusions) ? <Essential title="What’s not included" body={text(extras.exclusions)!} /> : null}{text(extras.notes) || view.special_requests ? <Essential title="Good to know" body={text(extras.notes) ?? view.special_requests!} /> : null}</section>

        <section className="flex flex-col items-center justify-between gap-5 rounded-3xl bg-[#073f39] p-7 text-white sm:flex-row"><div><p className="text-xl font-bold">Ready for your Oliday?</p><p className="mt-1 text-sm text-emerald-100">plan@oliday.app · WhatsApp +91 96866 67606</p></div><div className="flex flex-wrap gap-3"><a href={downloadUrl} className="rounded-xl bg-white px-5 py-3 text-sm font-bold text-[#073f39]">Download PDF</a><button onClick={share} className="rounded-xl bg-[#25D366] px-5 py-3 text-sm font-bold text-white">Share on WhatsApp</button></div></section>
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="bg-white p-5"><p className="text-[10px] font-bold tracking-widest text-[#0d8b76]">{label.toUpperCase()}</p><p className="mt-2 font-semibold">{value}</p></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-bold uppercase tracking-wide text-[#0d8b76]">{label}</p><p className="mt-1 text-slate-600">{value}</p></div>; }
function Essential({ title, body }: { title: string; body: string }) { return <article className="rounded-2xl border border-slate-200 bg-white p-6"><h3 className="text-lg font-bold text-[#073f39]">{title}</h3><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{body}</p></article>; }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function formatDate(value: string): string { return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
