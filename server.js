require('dotenv').config();
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const Database = require('better-sqlite3'), multer = require('multer'), nodemailer = require('nodemailer');
const cron = require('node-cron'), Razorpay = require('razorpay'), T = require('./templates');

const E = process.env, BASE = E.BASE_URL || 'http://localhost:3000', ADMIN = E.ADMIN_PASSWORD || 'admin';
const LIVE = !!(E.RAZORPAY_KEY_ID && E.RAZORPAY_KEY_SECRET); // no keys = demo payments
const rp = LIVE ? new Razorpay({ key_id: E.RAZORPAY_KEY_ID, key_secret: E.RAZORPAY_KEY_SECRET }) : null;
const mailer = E.SMTP_HOST ? nodemailer.createTransport({ host: E.SMTP_HOST, port: +(E.SMTP_PORT || 587), auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } }) : null;

fs.mkdirSync('data/uploads', { recursive: true });
const db = new Database('data/app.db');
db.exec(`
CREATE TABLE IF NOT EXISTS event(id INTEGER PRIMARY KEY CHECK(id=1),name,tagline,description,day,t_start,t_end,venue,address,price INTEGER,banner,visibility,capacity INTEGER,admin_emails TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS speakers(id INTEGER PRIMARY KEY,name,role,talk,photo,linkedin);
CREATE TABLE IF NOT EXISTS regs(id INTEGER PRIMARY KEY,name,email,company,phone,status,order_id,payment_id,refund_id,created_at DEFAULT CURRENT_TIMESTAMP,amount_paid INTEGER DEFAULT 0,discount_code TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY,reg_id INTEGER,kind,to_email,subject,body,send_at,sent_at);
DELETE FROM queue WHERE id NOT IN (
  SELECT MIN(id) FROM queue GROUP BY reg_id, kind, LOWER(to_email)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_registration_kind_recipient
  ON queue(reg_id, kind, LOWER(to_email));`);
// Migrate existing databases without losing registrations.
// Older deployed databases may predate fields used by the current registration
// and discount flow. CREATE TABLE IF NOT EXISTS does not add those columns.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('regs', 'phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('regs', 'amount_paid', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('regs', 'discount_code', "TEXT NOT NULL DEFAULT ''");
ensureColumn('event', 'admin_emails', "TEXT NOT NULL DEFAULT ''");
if (!db.prepare('SELECT 1 FROM event').get())
  db.prepare('INSERT INTO event VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'Bengaluru Product Summit 2026', 'A one-day conference on building products people love.',
    'Talks, workshops and long coffee breaks for product people.\n\nExpect practical sessions, no fluff.',
    '2026-12-05', '10:00', '17:30', 'Taj Yeshwantpur', '2275, Tumkur Rd, Yeshwantpur, Bengaluru 560022', 350000, '', 'masked', 300, '');
// Update the previous default ticket price without overwriting custom admin pricing.
db.prepare('UPDATE event SET price=350000 WHERE id=1 AND price=149900').run();

// ---------- helpers ----------
const ev = () => db.prepare('SELECT * FROM event WHERE id=1').get();
const speakers = () => db.prepare('SELECT * FROM speakers ORDER BY id').all();
const safe = u => (/^(https?:\/\/|\/uploads\/)/.test(u || '') ? u : ''); // blocks javascript: URLs
// Accept either a 10-digit Indian mobile number or an already-prefixed +91 number.
const normalizeIndianPhone = value => {
  const digits = String(value || '').replace(/\\D/g, '');
  if (/^91[6-9][0-9]{9}$/.test(digits)) return digits;
  if (/^[6-9][0-9]{9}$/.test(digits)) return '91' + digits;
  return '';
};
const startAt = e => new Date(`${e.day}T${e.t_start}:00+05:30`), endAt = e => new Date(`${e.day}T${e.t_end}:00+05:30`);
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const place = e => `${e.venue}, ${e.address}`;
const calUrl = e => 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(e.name) +
  '&dates=' + stamp(startAt(e)) + '/' + stamp(endAt(e)) + '&location=' + encodeURIComponent(place(e));
const mask = n => n.split(/\s+/).map(w => w[0] + '•'.repeat(Math.max(w.length - 1, 2))).join(' ');

function ctx(r, extra = {}) {
  const e = ev();
  return {
    name: r.name.split(' ')[0], fullName: r.name, email: r.email,
    phone: r.phone ? '+91' + String(r.phone).replace(/^91/, '') : '',
    company: r.company || '', registrationId: String(r.id), event: e.name, paymentId: r.payment_id || '',
    date: startAt(e).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }),
    time: `${e.t_start}–${e.t_end} IST`, venue: place(e), page: BASE, ics: BASE + '/api/ics', cal: calUrl(e),
    map: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place(e)),
    price: '₹' + ((r.amount_paid || e.price) / 100), originalPrice: '₹' + e.price / 100, discountCode: r.discount_code || '', receipt: String(r.id).padStart(5, '0'),
    speakers: speakers().map(s => `• ${s.name} – ${s.talk}`).join('\n'), ...extra
  };
}
function enqueueTo(r, kind, toEmail, when = new Date(), extra) {
  const t = T.emails[kind], c = ctx(r, extra);
  db.prepare('INSERT OR IGNORE INTO queue(reg_id,kind,to_email,subject,body,send_at) VALUES(?,?,?,?,?,?)')
    .run(r.id, kind, toEmail, T.merge(t.subject, c), T.merge(t.body, c), when.toISOString());
}
function enqueue(r, kind, when = new Date(), extra) {
  enqueueTo(r, kind, r.email, when, extra);
}

// Admin registration alerts are queued only after payment verification succeeds.
// Invalid addresses are ignored; duplicate addresses are collapsed case-insensitively.
function enqueueAdminRegistration(r, when = new Date()) {
  // Read the comma-separated recipients saved in Event Settings.
  // Validate each address and remove duplicates without regard to case.
  const admins = (ev().admin_emails || '').split(',')
    .map(x => x.trim())
    .filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  const uniqueAdmins = new Map(admins.map(email => [email.toLowerCase(), email]));
  for (const email of uniqueAdmins.values()) {
    enqueueTo(r, 'adminRegistration', email, when);
  }
}
async function flush() { // sends everything that is due; prints to console when SMTP isn't configured
  const due = db.prepare('SELECT * FROM queue WHERE sent_at IS NULL AND send_at<=?').all(new Date().toISOString());
  for (const m of due) {
    try {
      if (mailer) await mailer.sendMail({ from: E.MAIL_FROM || 'EventDesk <no-reply@example.com>', to: m.to_email, subject: m.subject, html: m.body });
      else console.log(`\n[MAIL -> ${m.to_email}] ${m.subject}\n${m.body}\n`);
      db.prepare('UPDATE queue SET sent_at=? WHERE id=?').run(new Date().toISOString(), m.id);
    } catch (err) { console.error('mail failed', m.id, err.message); }
  }
}
cron.schedule('* * * * *', flush);

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('data/uploads'));
const upload = multer({
  storage: multer.diskStorage({ destination: 'data/uploads', filename: (q, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')) }),
  limits: { fileSize: 5e6 }, fileFilter: (q, f, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(f.mimetype))
});

app.get('/api/event', (q, s) => {
  const e = ev(), v = e.visibility, acc = db.prepare("SELECT name,company FROM regs WHERE status='accepted' ORDER BY id").all();
  const attendees = v === 'public' ? acc : v === 'masked' ? acc.map(a => ({ name: mask(a.name), company: a.company ? mask(a.company) : '' })) : [];
  s.json({ event: e, speakers: speakers(), attendees, acceptedCount: v === 'hidden' ? null : acc.length });
});

app.post('/api/register', async (q, s) => {
  try {
    const n = (q.body.name || '').trim().slice(0, 80), m = (q.body.email || '').trim().toLowerCase().slice(0, 120), c = (q.body.company || '').trim().slice(0, 80), phone = normalizeIndianPhone(q.body.phone);
    if (!n || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m) || !c || !phone) return s.status(400).json({ error: 'Enter your full name, a valid email, company and valid Indian mobile number.' });
    const e = ev();
    const code = String(q.body.discountCode || '').trim().toUpperCase();
    if (code && code !== 'EE27') return s.status(400).json({ error: 'Invalid discount code.' });
    const discount = code === 'EE27' ? 50000 : 0;
    const amount = Math.max(0, e.price - discount);
    // A capacity of 0 means no limit. Only enforce a positive configured capacity.
    const confirmedCount = db.prepare("SELECT COUNT(*) n FROM regs WHERE status IN('accepted','pending_review')").get().n;
    if (Number(e.capacity) > 0 && confirmedCount >= Number(e.capacity)) {
      return s.status(409).json({
        code: 'EVENT_SOLD_OUT',
        error: 'This event is sold out. Please contact the organizers for assistance.'
      });
    }

    // Prevent duplicate paid registrations, but allow a user to retry after an
    // abandoned/failed payment (those records remain status='unpaid').
    const existingRegistration = db.prepare(
      "SELECT id, status FROM regs WHERE email=? AND status IN('accepted','pending_review') ORDER BY id DESC LIMIT 1"
    ).get(m);
    if (existingRegistration) {
      return s.status(409).json({
        code: 'EMAIL_ALREADY_REGISTERED',
        error: 'This email is already registered. Please use the email used for your existing registration or contact the organizers.'
      });
    }
    const id = db.prepare("INSERT INTO regs(name,email,company,phone,status,amount_paid,discount_code) VALUES(?,?,?,?, 'unpaid',?,?)").run(n, m, c, phone, amount, code).lastInsertRowid;
    const order = LIVE ? await rp.orders.create({ amount, currency: 'INR', receipt: 'reg_' + id }) : { id: 'order_demo_' + id };
    db.prepare('UPDATE regs SET order_id=? WHERE id=?').run(order.id, id);
    s.json({ regId: id, orderId: order.id, amount, originalAmount: e.price, discount, discountCode: code, keyId: E.RAZORPAY_KEY_ID || null, demo: !LIVE, name: n, email: m, phone, eventName: e.name });
  } catch (err) { console.error(err); s.status(500).json({ error: 'Could not start payment. Try again.' }); }
});

app.post('/api/verify', async (q, s) => {
  const { regId, razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: g } = q.body;
  const r = db.prepare("SELECT * FROM regs WHERE id=? AND status='unpaid'").get(regId);
  if (!r || r.order_id !== o) return s.status(400).json({ error: 'Unknown order' });
  if (LIVE) {
    const x = crypto.createHmac('sha256', E.RAZORPAY_KEY_SECRET).update(o + '|' + p).digest('hex');
    if (g !== x) return s.status(400).json({ error: 'Bad signature' });
  }
  const pid = p || 'pay_demo_' + regId;
  const confirmed = { ...r, payment_id: pid };
  // One atomic state transition + queue insert: repeated callbacks cannot create
  // another admin notification, and a failed mail send remains queued for retry.
  const confirmPayment = db.transaction(() => {
    const result = db.prepare(
      "UPDATE regs SET status='pending_review',payment_id=? WHERE id=? AND status='unpaid'"
    ).run(pid, regId);
    if (result.changes !== 1) return false;
    enqueue(confirmed, 'received');
    enqueueAdminRegistration(confirmed);
    return true;
  });
  if (!confirmPayment()) return s.status(200).json({ ok: true, duplicate: true });
  await flush();
  s.json({ ok: true });
});

app.get('/api/ics', (q, s) => {
  const e = ev();
  s.type('text/calendar').send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EventDesk//EN', 'BEGIN:VEVENT',
    'UID:' + stamp(startAt(e)) + '@eventdesk', 'DTSTAMP:' + stamp(new Date()), 'DTSTART:' + stamp(startAt(e)), 'DTEND:' + stamp(endAt(e)),
    'SUMMARY:' + e.name, 'LOCATION:' + place(e).replace(/,/g, '\\,'),
    'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Tomorrow: ' + e.name, 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Starting in 1 hour', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
});

// ---------- admin ----------
const h = x => crypto.createHash('sha256').update(x || '').digest();
app.use('/api/admin', (q, s, n) => (crypto.timingSafeEqual(h(q.get('x-admin-password')), h(ADMIN)) ? n() : s.status(401).json({ error: 'Unauthorized' })));

app.get('/api/admin/data', (q, s) => s.json({ event: ev(), speakers: speakers(), regs: db.prepare("SELECT * FROM regs WHERE status!='unpaid' ORDER BY id DESC").all(), totalRegs: db.prepare('SELECT COUNT(*) n FROM regs').get().n }));

// Export the same registration records shown in the organizer dashboard.
app.get('/api/admin/regs/export', async (q, s) => {
  const rows = db.prepare("SELECT id, name, email, company, phone, status, order_id, payment_id, refund_id, created_at FROM regs WHERE status!='unpaid' ORDER BY id DESC").all();
  const columns = ['id', 'name', 'email', 'company', 'phone', 'status', 'order_id', 'payment_id', 'refund_id', 'created_at'];
  const format = String(q.query.format || '').toLowerCase();
  if (format === 'csv') {
    const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const csv = [columns, ...rows.map(row => columns.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\r\n');
    s.setHeader('Content-Type', 'text/csv; charset=utf-8');
    s.setHeader('Content-Disposition', 'attachment; filename="eventdesk-registrations.csv"');
    return s.send('\uFEFF' + csv);
  }
  if (format === 'xlsx') {
    try {
      // ExcelJS replaces the vulnerable SheetJS `xlsx` package.
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Registrations');
      worksheet.columns = columns.map(key => ({ header: key, key, width: Math.max(14, key.length + 3) }));
      worksheet.addRows(rows);
      worksheet.getRow(1).font = { bold: true };
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
      const buffer = await workbook.xlsx.writeBuffer();
      s.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      s.setHeader('Content-Disposition', 'attachment; filename="eventdesk-registrations.xlsx"');
      return s.send(Buffer.from(buffer));
    } catch (error) {
      console.error('XLSX export failed:', error);
      return s.status(500).json({ error: 'Could not generate the XLSX export.' });
    }
  }
  return s.status(400).json({ error: 'Format must be csv or xlsx.' });
});

// Remove registration records and their queued emails in one transaction.
app.delete('/api/admin/regs', (q, s) => {
  db.transaction(() => {
    db.prepare('DELETE FROM queue WHERE reg_id IN (SELECT id FROM regs)').run();
    db.prepare('DELETE FROM regs').run();
  })();
  s.json({ ok: true });
});

app.post('/api/admin/upload', upload.single('file'), (q, s) =>
  q.file ? s.json({ url: '/uploads/' + q.file.filename }) : s.status(400).json({ error: 'Upload a png, jpg, webp or gif under 5 MB.' }));

app.put('/api/admin/event', (q, s) => {
  const b = q.body;
  db.prepare('UPDATE event SET name=?,tagline=?,description=?,day=?,t_start=?,t_end=?,venue=?,address=?,price=?,banner=?,visibility=?,capacity=?,admin_emails=? WHERE id=1')
    .run(b.name, b.tagline, b.description, b.day, b.t_start, b.t_end, b.venue, b.address, Math.round(+b.price) || 0, safe(b.banner),
      ['public', 'masked', 'count', 'hidden'].includes(b.visibility) ? b.visibility : 'masked', +b.capacity || 0, String(b.admin_emails || '').split(',').map(x=>x.trim()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).join(', '));
  s.json({ ok: true });
});

app.put('/api/admin/speakers', (q, s) => {
  db.transaction(list => {
    db.prepare('DELETE FROM speakers').run();
    for (const x of list) db.prepare('INSERT INTO speakers(name,role,talk,photo,linkedin) VALUES(?,?,?,?,?)').run(x.name || '', x.role || '', x.talk || '', safe(x.photo), safe(x.linkedin));
  })(Array.isArray(q.body) ? q.body : []);
  s.json({ ok: true });
});

app.post('/api/admin/regs/:id/decision', async (q, s) => {
  const r = db.prepare("SELECT * FROM regs WHERE id=? AND status='pending_review'").get(q.params.id);
  if (!r) return s.status(404).json({ error: 'This registration is not awaiting review.' });
  const e = ev();
  if (q.body.decision === 'accepted') {
    db.prepare("UPDATE regs SET status='accepted' WHERE id=?").run(r.id);
    enqueue(r, 'accepted');
    for (const [kind, min] of T.cadence) { const t = new Date(startAt(e) - min * 6e4); if (t > Date.now()) enqueue(r, kind, t); }
  } else if (q.body.decision === 'declined') {
    let note = 'Refund initiated; expect it in 5–7 working days.', rid = 'rfnd_demo';
    try { if (LIVE && r.payment_id) rid = (await rp.payments.refund(r.payment_id, { speed: 'normal' })).id; }
    catch (err) { console.error(err); rid = null; note = "We couldn't auto-refund; we'll process it manually within 48 hours."; }
    db.prepare("UPDATE regs SET status='declined',refund_id=? WHERE id=?").run(rid, r.id);
    enqueue(r, 'declined', new Date(), { joke: T.jokes[Math.floor(Math.random() * T.jokes.length)], refundNote: note });
  } else return s.status(400).json({ error: 'Decision must be accepted or declined.' });
  flush(); s.json({ ok: true });
});

app.listen(E.PORT || 3000, () => console.log(`EventDesk on ${BASE} | payments: ${LIVE ? 'Razorpay LIVE keys' : 'DEMO mode'} | mail: ${mailer ? 'SMTP' : 'console'} | admin: ${BASE}/#admin`));
