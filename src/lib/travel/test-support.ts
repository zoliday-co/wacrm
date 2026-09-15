// ============================================================
// In-memory Supabase fake for travel-layer tests.
//
// NOT a general PostgREST emulator — it implements exactly the
// query surface `src/lib/travel/*` uses (see the method inventory
// in the tests): select/insert/update/delete with eq, neq, in, is,
// not, or, gte, lte, lt, ilike, order, limit, range, single,
// maybeSingle, plus the one rpc (`next_booking_number`).
//
// Why a fake rather than mocks per test: the flows under test
// (ingestion → deal → lead → RFQ → quote → booking) span a dozen
// tables and read back what they just wrote. Assertions on real
// stored rows catch the bugs that matter (a duplicate lead, a
// missing snapshot); a chain of `vi.fn()` stubs would not.
//
// Nothing here ships to the app — it is imported only by *.test.ts.
// ============================================================

type Row = Record<string, unknown>;

interface Filter {
  kind: 'eq' | 'neq' | 'in' | 'is' | 'not' | 'gte' | 'lte' | 'gt' | 'lt' | 'like' | 'ilike' | 'or';
  column: string;
  value: unknown;
}

/** Postgres LIKE/ILIKE pattern → RegExp. `%` is the wildcard. */
function likeRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*')}$`, caseInsensitive ? 'i' : '');
}

export class FakeDbError extends Error {
  code: string;
  constructor(message: string, code = '23505') {
    super(message);
    this.code = code;
  }
}

function matches(row: Row, f: Filter): boolean {
  const actual = row[f.column];
  switch (f.kind) {
    case 'eq':
      return actual === f.value;
    case 'neq':
      return actual !== f.value;
    case 'in':
      return Array.isArray(f.value) && (f.value as unknown[]).includes(actual);
    case 'is':
      return f.value === null ? actual === null || actual === undefined : actual === f.value;
    case 'not': {
      // Only the two shapes the app uses: not('col','is',null) and
      // not('status','in','("A","B")').
      const { op, operand } = f.value as { op: string; operand: unknown };
      if (op === 'is') return operand === null ? actual !== null && actual !== undefined : actual !== operand;
      if (op === 'in') {
        const list = String(operand)
          .replace(/^\(|\)$/g, '')
          .split(',')
          .map((s) => s.trim().replace(/^"|"$/g, ''));
        return !list.includes(String(actual));
      }
      return true;
    }
    case 'gte':
      return actual != null && String(actual) >= String(f.value);
    case 'lte':
      return actual != null && String(actual) <= String(f.value);
    case 'gt':
      return actual != null && String(actual) > String(f.value);
    case 'lt':
      return actual != null && String(actual) < String(f.value);
    case 'like':
      return typeof actual === 'string' && likeRegExp(String(f.value), false).test(actual);
    case 'ilike':
      return typeof actual === 'string' && likeRegExp(String(f.value), true).test(actual);
    case 'or': {
      // `a.ilike.%x%,b.eq.y` — true when any clause matches.
      return String(f.value)
        .split(',')
        .some((clause) => {
          const [col, op, ...rest] = clause.split('.');
          const val = rest.join('.');
          const cell = row[col];
          if (op === 'ilike') return typeof cell === 'string' && likeRegExp(val, true).test(cell);
          if (op === 'eq') return String(cell) === val;
          if (op === 'is') return val === 'null' ? cell === null || cell === undefined : String(cell) === val;
          if (op === 'gte') return cell != null && String(cell) >= val;
          return false;
        });
    }
    default:
      return true;
  }
}

interface Unique {
  table: string;
  columns: string[];
  /** Only enforce when every column is non-null (partial index). */
  whereNotNull?: string[];
}

/** The unique constraints the travel migrations declare that tests rely on. */
const UNIQUES: Unique[] = [
  { table: 'travel_leads', columns: ['account_id', 'bot_session_id'], whereNotNull: ['bot_session_id'] },
  { table: 'bookings', columns: ['traveller_quote_id'], whereNotNull: ['traveller_quote_id'] },
  { table: 'travel_tasks', columns: ['account_id', 'source_key'], whereNotNull: ['source_key'] },
  { table: 'travel_requirement_versions', columns: ['travel_lead_id', 'version'] },
  { table: 'rfqs', columns: ['travel_lead_id', 'version'] },
  { table: 'rfq_suppliers', columns: ['rfq_id', 'supplier_id'] },
  { table: 'supplier_quotes', columns: ['rfq_supplier_id', 'version'] },
  { table: 'traveller_quotes', columns: ['travel_lead_id', 'version'] },
  { table: 'travel_settings', columns: ['account_id'] },
  { table: 'conversations', columns: ['account_id', 'contact_id'] },
];

/**
 * Column defaults Postgres fills in on INSERT. The travel code inserts
 * a bare `{ account_id }` settings row and then reads the knobs back,
 * so a fake without defaults produces NaN deadlines rather than a
 * failing assertion. Mirrors migrations 041–047; only the columns the
 * code actually reads back are listed.
 */
const DEFAULTS: Record<string, Row> = {
  travel_settings: {
    currency: 'INR',
    max_suppliers_per_rfq: 5,
    min_quotes_before_notification: 3,
    rfq_deadline_hours: 24,
    supplier_quote_token_ttl_hours: 72,
    supplier_reminder_hours: 4,
    supplier_max_reminders: 2,
    auto_send_rfq: true,
    auto_notify_traveller: true,
    supplier_rfq_template_name: null,
    supplier_rfq_template_language: null,
    traveller_quotes_ready_template_name: null,
    traveller_quotes_ready_template_language: null,
    callback_token_ttl_hours: 168,
    gst_rate: '5.00',
    gst_taxable_base: 'selling_price',
    default_markup_type: 'percent',
    default_markup_value: '15.00',
    margin_warning_pct: '8.00',
    margin_approval_pct: null,
    traveller_quote_validity_days: 7,
    pipeline_id: null,
  },
  travel_leads: { destinations: [], child_ages: [], hotel_preferences: [], activities: [], adults: 0, children: 0, infants: 0, dates_flexible: true, current_requirement_version: 1, status: 'QUALIFIED', last_activity_at: new Date().toISOString() },
  rfqs: { status: 'DRAFT', version: 1, recipient_count: 0, response_count: 0 },
  rfq_suppliers: { status: 'PENDING', reminder_count: 0, send_attempts: 0 },
  supplier_quotes: { currency: 'INR', version: 1, status: 'SUBMITTED', hotel_details: [], transport_details: {}, activity_details: [] },
  traveller_quotes: { currency: 'INR', version: 1, status: 'DRAFT', approval_status: 'not_required', discount_amount: '0.00' },
  bookings: { status: 'CONFIRMED', currency: 'INR', amount_received: '0.00', supplier_amount_paid: '0.00', adults: 0, children: 0, infants: 0, financial_snapshot: {} },
  travel_tasks: { status: 'OPEN', priority: 'NORMAL', task_type: 'GENERAL' },
  callback_requests: { status: 'REQUESTED' },
  itineraries: { version: 1, status: 'DRAFT', generated_by: 'manual', extras: {} },
  suppliers: { status: 'ACTIVE', supplier_type: 'DMC', preferred: false, active: true, metadata: {}, deleted_at: null },
  destinations: { active: true, aliases: [] },
  supplier_destinations: { priority: 100, preferred: false, active: true, service_types: [] },
  contacts: { opted_out: false },
  conversations: { status: 'open', unread_count: 0, trip: {} },
  deals: { status: 'open', value: 0, currency: 'USD' },
  travel_lead_events: { actor_type: 'system', details: {} },
};

/**
 * Postgres triggers the travel schema relies on, applied after an
 * insert/update so the fake's stored rows match what the app reads
 * back from a real database (see migration 047's balance triggers).
 */
function applyTriggers(table: string, row: Row, store: Map<string, Row[]>) {
  if (table === 'bookings') {
    row.customer_balance = numericMinus(row.traveller_total, row.amount_received);
    row.supplier_balance = numericMinus(row.supplier_cost, row.supplier_amount_paid);
  }
  if (table === 'customer_payments' || table === 'supplier_payments') {
    recomputeBookingBalances(String(row.booking_id), store);
  }
}

function numericMinus(a: unknown, b: unknown): string {
  return (Math.round((Number(a ?? 0) - Number(b ?? 0)) * 100) / 100).toFixed(2);
}

/** Mirrors `recompute_booking_balances()` from migration 047. */
function recomputeBookingBalances(bookingId: string, store: Map<string, Row[]>) {
  const booking = (store.get('bookings') ?? []).find((b) => b.id === bookingId);
  if (!booking) return;
  const received = (store.get('customer_payments') ?? [])
    .filter((p) => p.booking_id === bookingId)
    .reduce((sum, p) => {
      if (p.payment_status === 'RECEIVED') return sum + Number(p.amount ?? 0);
      if (p.payment_status === 'PARTIALLY_REFUNDED') return sum + Number(p.amount ?? 0) - Number(p.refunded_amount ?? 0);
      return sum;
    }, 0);
  const paid = (store.get('supplier_payments') ?? [])
    .filter((p) => p.booking_id === bookingId && p.status === 'PAID')
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

  booking.amount_received = received.toFixed(2);
  booking.customer_balance = numericMinus(booking.traveller_total, received);
  booking.supplier_amount_paid = paid.toFixed(2);
  booking.supplier_balance = numericMinus(booking.supplier_cost, paid);

  const total = Number(booking.traveller_total ?? 0);
  if (['CONFIRMED', 'PARTIALLY_PAID', 'FULLY_PAID'].includes(String(booking.status))) {
    booking.status = received >= total && total > 0 ? 'FULLY_PAID' : received > 0 ? 'PARTIALLY_PAID' : 'CONFIRMED';
  }
}

// ------------------------------------------------------------
// Embedded selects (`*, supplier:suppliers(*)`)
//
// PostgREST resolves embeds through foreign keys. The fake infers
// them from naming conventions, with an explicit map for the FKs
// whose column name doesn't match the alias or the table.
// ------------------------------------------------------------

/** `alias@parentTable` → the column on the PARENT holding the child id. */
const EMBED_FK: Record<string, string> = {
  'supplier@bookings': 'selected_supplier_id',
  'latest_quote@rfq_suppliers': 'latest_quote_id',
  'assigned_agent@travel_leads': 'assigned_agent_id',
  'agent@lead_interactions': 'agent_id',
  'stage@deals': 'stage_id',
  'assignee@deals': 'assigned_to',
  'travel_lead@travel_tasks': 'travel_lead_id',
  'supplier_quote@traveller_quotes': 'supplier_quote_id',
};

/** Tables whose primary key the app joins on is NOT `id`. */
const JOIN_KEY: Record<string, string> = { profiles: 'user_id' };

function singular(table: string): string {
  if (table === 'itineraries') return 'itinerary';
  if (table === 'rfqs') return 'rfq';
  return table.replace(/ies$/, 'y').replace(/s$/, '');
}

interface Embed {
  alias: string;
  table: string;
  /** The embed's own select string, for nesting. */
  inner: string;
}

/**
 * Split a PostgREST select into its top-level embeds. Handles one
 * level of nesting inside each embed (`a:b(*, c:d(*))`).
 */
function parseEmbeds(select: string): Embed[] {
  const embeds: Embed[] = [];
  let i = 0;
  while (i < select.length) {
    const open = select.indexOf('(', i);
    if (open === -1) break;
    // Walk back to the start of this embed's name.
    let start = open - 1;
    while (start >= 0 && /[A-Za-z0-9_:!]/.test(select[start])) start -= 1;
    const head = select.slice(start + 1, open);
    // Match the closing paren, accounting for nesting.
    let depth = 1;
    let close = open + 1;
    while (close < select.length && depth > 0) {
      if (select[close] === '(') depth += 1;
      if (select[close] === ')') depth -= 1;
      close += 1;
    }
    const inner = select.slice(open + 1, close - 1);
    // `alias:table!fk_constraint` → alias + table
    const [aliasPart, tablePart] = head.includes(':') ? head.split(':') : [head, head];
    const table = tablePart.split('!')[0];
    embeds.push({ alias: aliasPart, table, inner });
    i = close;
  }
  return embeds;
}

/** Attach every embed named in `select` onto a copy of `row`. */
function resolveEmbeds(row: Row, parentTable: string, select: string, store: Map<string, Row[]>): Row {
  const out = { ...row };
  for (const embed of parseEmbeds(select)) {
    const childRows = store.get(embed.table) ?? [];
    const fkColumn = EMBED_FK[`${embed.alias}@${parentTable}`] ?? `${embed.alias}_id`;
    const altColumn = `${singular(embed.table)}_id`;
    const parentFk = fkColumn in row ? fkColumn : altColumn in row ? altColumn : null;

    if (parentFk) {
      // many-to-one: the parent points at one child row.
      const key = JOIN_KEY[embed.table] ?? 'id';
      const match = childRows.find((c) => c[key] === row[parentFk]);
      out[embed.alias] = match ? resolveEmbeds(match, embed.table, embed.inner, store) : null;
    } else {
      // one-to-many: children point back at the parent.
      const backRef = `${singular(parentTable)}_id`;
      const matches = childRows.filter((c) => c[backRef] === row.id);
      out[embed.alias] = matches.map((c) => resolveEmbeds(c, embed.table, embed.inner, store));
    }
  }
  return out;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(4, '0')}`;
}

export interface FakeDbOptions {
  /** Rows to preload, keyed by table. */
  seed?: Record<string, Row[]>;
}

/**
 * Minimal Supabase-shaped client backed by plain arrays.
 * `db.rows('travel_leads')` exposes the store for assertions.
 */
export function createFakeDb(options: FakeDbOptions = {}) {
  const store = new Map<string, Row[]>();
  for (const [table, rows] of Object.entries(options.seed ?? {})) {
    store.set(table, rows.map((r) => ({ ...r })));
  }
  const bookingCounters = new Map<string, number>();

  const tableRows = (table: string): Row[] => {
    if (!store.has(table)) store.set(table, []);
    return store.get(table)!;
  };

  function checkUnique(table: string, row: Row) {
    for (const u of UNIQUES) {
      if (u.table !== table) continue;
      if (u.whereNotNull?.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = tableRows(table).some((existing) => u.columns.every((c) => existing[c] === row[c]));
      if (clash) {
        throw new FakeDbError(`duplicate key value violates unique constraint "${table}_${u.columns.join('_')}_key"`);
      }
    }
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitCount: number | null = null;
    let rangeBounds: { from: number; to: number } | null = null;
    let wantCount = false;
    let headOnly = false;
    let selectClause = '*';

    const applyFilters = (rows: Row[]) => rows.filter((r) => filters.every((f) => matches(r, f)));

    function resolve(): { data: unknown; error: unknown; count?: number } {
      try {
        if (mode === 'insert') {
          const inserted: Row[] = [];
          for (const raw of payload) {
            const row: Row = {
              id: nextId(table.slice(0, 4)),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...(DEFAULTS[table] ?? {}),
              // An explicit null means "no value", so it must win over
              // the column default exactly as it does in Postgres.
              ...raw,
            };
            checkUnique(table, row);
            tableRows(table).push(row);
            applyTriggers(table, row, store);
            inserted.push(row);
          }
          return { data: inserted.map((r) => resolveEmbeds(r, table, selectClause, store)), error: null };
        }
        if (mode === 'update') {
          const target = applyFilters(tableRows(table));
          for (const row of target) {
            Object.assign(row, payload[0], { updated_at: new Date().toISOString() });
            applyTriggers(table, row, store);
          }
          return { data: target.map((r) => resolveEmbeds(r, table, selectClause, store)), error: null };
        }
        if (mode === 'delete') {
          const target = applyFilters(tableRows(table));
          const keep = tableRows(table).filter((r) => !target.includes(r));
          store.set(table, keep);
          for (const row of target) applyTriggers(table, row, store);
          return { data: target, error: null };
        }
        let rows = applyFilters(tableRows(table));
        const count = rows.length;
        if (orderBy) {
          const { column, ascending } = orderBy;
          rows = [...rows].sort((a, b) => {
            const av = a[column] == null ? '' : String(a[column]);
            const bv = b[column] == null ? '' : String(b[column]);
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (rangeBounds) rows = rows.slice(rangeBounds.from, rangeBounds.to + 1);
        if (limitCount !== null) rows = rows.slice(0, limitCount);
        const projected = rows.map((r) => resolveEmbeds(r, table, selectClause, store));
        return { data: headOnly ? null : projected, error: null, ...(wantCount ? { count } : {}) };
      } catch (err) {
        if (err instanceof FakeDbError) return { data: null, error: { message: err.message, code: err.code } };
        throw err;
      }
    }

    const api = {
      select(columns?: string, opts?: { count?: string; head?: boolean }) {
        if (columns) selectClause = columns;
        if (opts?.count) wantCount = true;
        if (opts?.head) headOnly = true;
        return api;
      },
      insert(rows: Row | Row[]) {
        mode = 'insert';
        payload = Array.isArray(rows) ? rows : [rows];
        return api;
      },
      update(patch: Row) {
        mode = 'update';
        payload = [patch];
        return api;
      },
      delete() {
        mode = 'delete';
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push({ kind: 'eq', column, value });
        return api;
      },
      neq(column: string, value: unknown) {
        filters.push({ kind: 'neq', column, value });
        return api;
      },
      in(column: string, value: unknown[]) {
        filters.push({ kind: 'in', column, value });
        return api;
      },
      is(column: string, value: unknown) {
        filters.push({ kind: 'is', column, value });
        return api;
      },
      not(column: string, op: string, operand: unknown) {
        filters.push({ kind: 'not', column, value: { op, operand } });
        return api;
      },
      or(clause: string) {
        filters.push({ kind: 'or', column: '*', value: clause });
        return api;
      },
      gte(column: string, value: unknown) {
        filters.push({ kind: 'gte', column, value });
        return api;
      },
      lte(column: string, value: unknown) {
        filters.push({ kind: 'lte', column, value });
        return api;
      },
      gt(column: string, value: unknown) {
        filters.push({ kind: 'gt', column, value });
        return api;
      },
      lt(column: string, value: unknown) {
        filters.push({ kind: 'lt', column, value });
        return api;
      },
      like(column: string, value: string) {
        filters.push({ kind: 'like', column, value });
        return api;
      },
      ilike(column: string, value: string) {
        filters.push({ kind: 'ilike', column, value });
        return api;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderBy = { column, ascending: opts?.ascending !== false };
        return api;
      },
      limit(n: number) {
        limitCount = n;
        return api;
      },
      range(from: number, to: number) {
        rangeBounds = { from, to };
        return api;
      },
      single() {
        const { data, error } = resolve();
        const rows = (data as Row[] | null) ?? [];
        if (error) return Promise.resolve({ data: null, error });
        if (rows.length !== 1) {
          return Promise.resolve({ data: rows[0] ?? null, error: rows.length === 0 ? { message: 'No rows found', code: 'PGRST116' } : null });
        }
        return Promise.resolve({ data: rows[0], error: null });
      },
      maybeSingle() {
        const { data, error } = resolve();
        const rows = (data as Row[] | null) ?? [];
        return Promise.resolve({ data: rows[0] ?? null, error: error ?? null });
      },
      // Awaiting the builder directly runs the query (PostgREST behaviour).
      then<T>(onFulfilled: (value: { data: unknown; error: unknown; count?: number }) => T) {
        return Promise.resolve(resolve()).then(onFulfilled);
      },
    };
    return api;
  }

  return {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'next_booking_number') {
        const account = String(args.p_account_id);
        const year = new Date().getUTCFullYear();
        const key = `${account}:${year}`;
        const next = (bookingCounters.get(key) ?? 0) + 1;
        bookingCounters.set(key, next);
        return Promise.resolve({ data: `${args.p_prefix ?? 'OLI'}-${year}-${String(next).padStart(5, '0')}`, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
    },
    /** Test accessor: the live rows of a table. */
    rows: (table: string): Row[] => tableRows(table),
    /** Test accessor: replace a table's rows. */
    setRows: (table: string, rows: Row[]) => store.set(table, rows),
  };
}

export type FakeDb = ReturnType<typeof createFakeDb>;

/** A minimal account with WhatsApp configured — the common precondition. */
export function baseSeed(accountId = 'acct-1', ownerId = 'user-owner'): Record<string, Row[]> {
  return {
    accounts: [{ id: accountId, name: 'Oliday', owner_user_id: ownerId, default_currency: 'INR' }],
    profiles: [
      { id: 'prof-owner', user_id: ownerId, account_id: accountId, account_role: 'owner', full_name: 'Owner', email: 'owner@oliday.test' },
      { id: 'prof-agent', user_id: 'user-agent', account_id: accountId, account_role: 'agent', full_name: 'Priya', email: 'priya@oliday.test' },
    ],
    whatsapp_config: [{ id: 'cfg-1', account_id: accountId, user_id: ownerId, phone_number_id: 'PNID', access_token: 'enc', status: 'connected' }],
  };
}
