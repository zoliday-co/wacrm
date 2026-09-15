import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib';
import type { PublicItineraryView } from './itinerary-sharing';

const PAGE: [number, number] = [595.28, 841.89];
const MARGIN = 46;
const INK = rgb(0.10, 0.16, 0.22);
const MUTED = rgb(0.38, 0.43, 0.48);
const BRAND = rgb(0.06, 0.54, 0.45);
const BRAND_DARK = rgb(0.03, 0.31, 0.28);
const SAND = rgb(0.96, 0.93, 0.84);

export async function renderItineraryPdf(view: PublicItineraryView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(view.itinerary.title);
  doc.setAuthor('Oliday');
  doc.setSubject(`Travel itinerary for ${view.destination ?? 'your holiday'}`);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [logoBytes, oliBytes] = await Promise.all([
    readFile(path.join(process.cwd(), 'public', 'oliday_logo.png')),
    readFile(path.join(process.cwd(), 'public', 'oli.png')),
  ]);
  const logo = await doc.embedPng(logoBytes);
  const oli = await doc.embedPng(oliBytes);

  drawCover(doc.addPage(PAGE), view, regular, bold, logo, oli);
  let page = doc.addPage(PAGE);
  let y = drawPageHeader(page, logo, bold, 'Your journey, day by day');
  for (const day of view.itinerary.days ?? []) {
    const needed = estimateDayHeight(day.description, day.activities?.length ?? 0);
    if (y - needed < 70) {
      page = doc.addPage(PAGE);
      y = drawPageHeader(page, logo, bold, 'Your journey, continued');
    }
    y = drawDay(page, y, day, regular, bold);
  }

  const extras = view.itinerary.extras ?? {};
  const sections = [
    ['Inclusions', textValue(extras.inclusions)],
    ['Exclusions', textValue(extras.exclusions)],
    ['Good to know', textValue(extras.notes) ?? view.special_requests],
  ] as const;
  if (sections.some(([, body]) => body)) {
    page = doc.addPage(PAGE);
    y = drawPageHeader(page, logo, bold, 'Trip essentials');
    for (const [title, body] of sections) {
      if (!body) continue;
      y = drawSection(page, y, title, body, regular, bold);
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, index) => {
    p.drawLine({ start: { x: MARGIN, y: 34 }, end: { x: PAGE[0] - MARGIN, y: 34 }, thickness: 0.5, color: rgb(0.83, 0.85, 0.84) });
    p.drawText(`Oliday  |  plan@oliday.app  |  +91 96866 67606`, { x: MARGIN, y: 19, size: 7.5, font: regular, color: MUTED });
    p.drawText(`${index + 1} / ${pages.length}`, { x: PAGE[0] - 76, y: 19, size: 7.5, font: regular, color: MUTED });
  });
  return doc.save();
}

function drawCover(page: PDFPage, view: PublicItineraryView, regular: PDFFont, bold: PDFFont, logo: PDFImage, oli: PDFImage) {
  page.drawRectangle({ x: 0, y: 520, width: PAGE[0], height: PAGE[1] - 520, color: BRAND_DARK });
  drawImageFit(page, logo, 46, 758, 150, 48);
  page.drawText('YOUR PERSONALISED JOURNEY', { x: 48, y: 704, size: 10, font: bold, color: SAND });
  const titleLines = wrap(view.itinerary.title, bold, 28, 460);
  let y = 661;
  for (const line of titleLines.slice(0, 3)) { page.drawText(line, { x: 48, y, size: 28, font: bold, color: rgb(1, 1, 1) }); y -= 34; }
  if (view.itinerary.summary) {
    y -= 6;
    for (const line of wrap(view.itinerary.summary, regular, 11, 410).slice(0, 4)) { page.drawText(line, { x: 48, y, size: 11, font: regular, color: rgb(0.86, 0.94, 0.92) }); y -= 16; }
  }
  drawImageFit(page, oli, 405, 462, 145, 190);
  page.drawText(view.traveller_name ? `Prepared for ${clean(view.traveller_name)}` : 'Prepared especially for you', { x: 48, y: 472, size: 12, font: bold, color: BRAND_DARK });
  const facts = [
    ['DESTINATION', view.destination ?? 'To be confirmed'],
    ['TRAVEL', view.travel_start_date ? `${view.travel_start_date}${view.travel_end_date ? ` to ${view.travel_end_date}` : ''}` : view.travel_month ?? 'Flexible dates'],
    ['DURATION', `${view.nights ?? '-'} nights / ${view.days ?? '-'} days`],
    ['TRAVELLERS', `${view.adults} adults${view.children ? ` + ${view.children} children` : ''}`],
    ['STAY', [view.hotel_category, view.room_configuration, view.meal_plan].filter(Boolean).join(' | ') || 'To be confirmed'],
    ['TRANSPORT', view.vehicle_type ?? 'To be confirmed'],
  ];
  y = 420;
  facts.forEach(([label, value], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 48 + col * 255;
    const fy = y - row * 82;
    page.drawText(label, { x, y: fy, size: 8, font: bold, color: BRAND });
    for (const [i, line] of wrap(value, bold, 12, 220).slice(0, 2).entries()) page.drawText(line, { x, y: fy - 20 - i * 15, size: 12, font: bold, color: INK });
  });
}

function drawPageHeader(page: PDFPage, logo: PDFImage, bold: PDFFont, title: string): number {
  page.drawRectangle({ x: 0, y: PAGE[1] - 92, width: PAGE[0], height: 92, color: BRAND_DARK });
  drawImageFit(page, logo, MARGIN, PAGE[1] - 69, 105, 34);
  page.drawText(clean(title), { x: MARGIN, y: PAGE[1] - 116, size: 20, font: bold, color: BRAND_DARK });
  return PAGE[1] - 145;
}

function drawDay(page: PDFPage, top: number, day: NonNullable<PublicItineraryView['itinerary']['days']>[number], regular: PDFFont, bold: PDFFont): number {
  const desc = day.description ? wrap(day.description, regular, 9.5, 430) : [];
  const detailLines = [day.hotel && `Stay: ${day.hotel}`, day.meals && `Meals: ${day.meals}`, day.transport && `Transport: ${day.transport}`].filter(Boolean) as string[];
  const activityLines = (day.activities ?? []).flatMap((a) => wrap(`- ${a}`, regular, 9, 420));
  const height = 61 + desc.length * 13 + detailLines.length * 13 + activityLines.length * 12;
  page.drawRectangle({ x: MARGIN, y: top - height, width: PAGE[0] - MARGIN * 2, height, color: rgb(0.975, 0.98, 0.975), borderColor: rgb(0.85, 0.89, 0.87), borderWidth: 0.7 });
  page.drawRectangle({ x: MARGIN, y: top - height, width: 8, height, color: BRAND });
  page.drawText(`DAY ${day.day_number}`, { x: MARGIN + 22, y: top - 25, size: 8, font: bold, color: BRAND });
  page.drawText(clean(day.date ?? ''), { x: PAGE[0] - 130, y: top - 25, size: 8, font: regular, color: MUTED });
  page.drawText(clean(day.title), { x: MARGIN + 22, y: top - 45, size: 13, font: bold, color: INK });
  let y = top - 64;
  for (const line of desc) { page.drawText(line, { x: MARGIN + 22, y, size: 9.5, font: regular, color: MUTED }); y -= 13; }
  for (const line of detailLines) { page.drawText(clean(line), { x: MARGIN + 22, y, size: 9, font: bold, color: INK }); y -= 13; }
  for (const line of activityLines) { page.drawText(line, { x: MARGIN + 32, y, size: 9, font: regular, color: MUTED }); y -= 12; }
  return top - height - 14;
}

function drawSection(page: PDFPage, top: number, title: string, body: string, regular: PDFFont, bold: PDFFont): number {
  const lines = body.split(/\r?\n/).flatMap((line) => wrap(line || ' ', regular, 10, 450));
  const height = 48 + lines.length * 14;
  page.drawRectangle({ x: MARGIN, y: top - height, width: PAGE[0] - MARGIN * 2, height, color: rgb(0.975, 0.98, 0.975), borderColor: rgb(0.85, 0.89, 0.87), borderWidth: 0.7 });
  page.drawText(clean(title), { x: MARGIN + 18, y: top - 27, size: 13, font: bold, color: BRAND_DARK });
  let y = top - 48;
  for (const line of lines) { page.drawText(line, { x: MARGIN + 18, y, size: 10, font: regular, color: MUTED }); y -= 14; }
  return top - height - 16;
}

function estimateDayHeight(description: string | null, activities: number): number {
  return 95 + Math.ceil((description?.length ?? 0) / 75) * 13 + activities * 16;
}

function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const words = clean(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function clean(value: string): string {
  return String(value).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/₹/g, 'Rs. ').replace(/[^\x20-\x7E]/g, ' ');
}

function drawImageFit(page: PDFPage, image: PDFImage, x: number, y: number, maxW: number, maxH: number) {
  const scale = Math.min(maxW / image.width, maxH / image.height);
  page.drawImage(image, { x, y, width: image.width * scale, height: image.height * scale });
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
