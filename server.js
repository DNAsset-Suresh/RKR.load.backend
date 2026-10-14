const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const {
  money,
  toTons,
  calcTransaction,
  calcAggregate,
  enrichTransaction,
} = require('./calc');

const {
  buildWorkbook,
  buildCsv,
  COLUMNS,
} = require('./excelService');

// Global PrismaClient to prevent connection exhaustion in serverless environments
const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Helper Date Utilities
function getTodayISO() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function getDayName(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

function getWeekStartISO(isoDate) {
  const d = new Date((isoDate || getTodayISO()) + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return d.toISOString().slice(0, 10);
}

function getWeekEndISO(isoDate) {
  const d = new Date((isoDate || getTodayISO()) + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = d.getUTCDate() + (day === 0 ? 0 : 7 - day);
  d.setUTCDate(diff);
  return d.toISOString().slice(0, 10);
}

function getMonthStartISO(isoDate) {
  const base = isoDate || getTodayISO();
  return base.slice(0, 7) + '-01';
}

// Helper to get typed settings
async function getSettings() {
  const settingsArray = await prisma.setting.findMany();
  let raw = {};
  if (settingsArray.length === 0) {
    raw = {
      customerRatePerTon: '930',
      companyRatePerTon: '920',
      rkrProfitPerTon: '10',
      customerGstRate: '5',
      companyGstRate: '5',
      maximumLoads: '10000',
      businessName: 'RKR ENTERPRISES',
      businessTagline: 'PLANNING | SOLUTIONS | GROWTH',
      businessAddress: 'Chennai, TN',
      businessPhone: '9876543210',
      businessEmail: 'info@rkrenterprises.com',
      invoicePrefix: 'RKR-'
    };
    for (const [key, value] of Object.entries(raw)) {
      await prisma.setting.create({ data: { key, value } });
    }
  } else {
    for (const s of settingsArray) {
      raw[s.key] = s.value;
    }
  }

  const num = (k, def = 0) => (raw[k] !== undefined ? Number(raw[k]) : def);
  const loadCount = await prisma.transaction.count();
  const maximumLoads = num('maximumLoads', 10000);

  return {
    customerRatePerTon: num('customerRatePerTon', 930),
    companyRatePerTon: num('companyRatePerTon', 920),
    rkrProfitPerTon: num('rkrProfitPerTon', 10),
    customerGstRate: num('customerGstRate', 5),
    companyGstRate: num('companyGstRate', 5),
    maximumLoads: maximumLoads,
    businessName: raw.businessName || 'RKR ENTERPRISES',
    businessTagline: raw.businessTagline || 'Logistics',
    businessAddress: raw.businessAddress || 'Chennai, TN',
    businessPhone: raw.businessPhone || '9876543210',
    businessEmail: raw.businessEmail || 'info@rkrenterprises.com',
    invoicePrefix: raw.invoicePrefix || 'RKR-',
    capacity: {
      used: loadCount,
      remaining: Math.max(0, maximumLoads - loadCount),
      maximumLoads: maximumLoads
    }
  };
}

// Build where clause from query parameters
function buildWhereClause(query) {
  const { from, to, vehicle, date } = query;
  let where = {};

  if (date) {
    where.date = date;
  } else if (from || to) {
    where.date = {};
    if (from) where.date.gte = from;
    if (to) where.date.lte = to;
  }

  if (vehicle) {
    where.vehicleNumber = {
      contains: vehicle,
      mode: 'insensitive'
    };
  }

  return where;
}

// Settings Endpoints
app.get('/api/settings', async (req, res) => {
  try {
    res.json({ data: await getSettings() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await prisma.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) }
      });
    }
    res.json({ message: 'Settings updated successfully', data: await getSettings() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Transactions Preview
app.post('/api/transactions/preview', async (req, res) => {
  try {
    const { weightKg } = req.body;
    const settings = await getSettings();
    const result = calcTransaction(weightKg, settings);
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Transactions List
app.get('/api/transactions', async (req, res) => {
  try {
    const settings = await getSettings();
    const where = buildWhereClause(req.query);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize || req.query.limit, 10) || 50);

    // Get all matching transactions to calculate totals accurately
    const allMatching = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }]
    });

    const totalCount = allMatching.length;
    const totalKg = allMatching.reduce((acc, t) => acc + Number(t.weightKg || 0), 0);
    const totals = calcAggregate(totalKg, totalCount, settings);

    // Paginate
    const skip = (page - 1) * pageSize;
    const paginated = allMatching.slice(skip, skip + pageSize);
    const enrichedRows = paginated.map(t => enrichTransaction(t, settings));

    res.json({
      data: enrichedRows,
      total: totalCount,
      meta: {
        page,
        pageSize,
        total: totalCount,
        pageCount: Math.ceil(totalCount / pageSize) || 1,
        totals
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Create Transaction
app.post('/api/transactions', async (req, res) => {
  try {
    const { date, vehicleNumber, weightKg } = req.body;
    const settings = await getSettings();
    const calc = calcTransaction(weightKg, settings);

    const newTx = await prisma.transaction.create({
      data: {
        date,
        vehicleNumber: (vehicleNumber || '').trim().toUpperCase(),
        weightKg: calc.weightKg,
        weightTons: calc.weightTons,
        customerTotalAmount: calc.customerTotalAmount,
        companyTotalAmount: calc.companyTotalAmount,
        rkrProfit: calc.rkrProfit,
        rkrProfitPerTon: calc.rkrProfitPerTon
      }
    });

    res.json({ data: enrichTransaction(newTx, settings) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Update Transaction
app.put('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { date, vehicleNumber, weightKg } = req.body;
    const settings = await getSettings();
    const calc = calcTransaction(weightKg, settings);

    const updated = await prisma.transaction.update({
      where: { id },
      data: {
        date,
        vehicleNumber: (vehicleNumber || '').trim().toUpperCase(),
        weightKg: calc.weightKg,
        weightTons: calc.weightTons,
        customerTotalAmount: calc.customerTotalAmount,
        companyTotalAmount: calc.companyTotalAmount,
        rkrProfit: calc.rkrProfit,
        rkrProfitPerTon: calc.rkrProfitPerTon
      }
    });

    res.json({ data: enrichTransaction(updated, settings) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete Transaction
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.transaction.delete({ where: { id } });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Bulk Upload Transactions
app.post('/api/transactions/bulk', async (req, res) => {
  try {
    const { loads } = req.body;
    if (!Array.isArray(loads) || loads.length === 0) {
      return res.status(400).json({ error: 'No loads provided' });
    }

    const settings = await getSettings();
    const dates = [...new Set(loads.map(l => l.date))];
    const vehicleNumbers = [...new Set(loads.map(l => (l.vehicleNumber || '').trim().toUpperCase()))];

    const existingTxs = await prisma.transaction.findMany({
      where: {
        date: { in: dates },
        vehicleNumber: { in: vehicleNumbers }
      },
      select: { date: true, vehicleNumber: true, weightKg: true }
    });

    const existingSet = new Set(
      existingTxs.map(t => `${t.date}_${t.vehicleNumber}_${t.weightKg}`)
    );

    const validRows = [];
    const duplicateRows = [];

    for (const load of loads) {
      const vNum = (load.vehicleNumber || '').trim().toUpperCase();
      const key = `${load.date}_${vNum}_${load.weightKg}`;
      if (existingSet.has(key)) {
        duplicateRows.push(load);
      } else {
        const calc = calcTransaction(load.weightKg, settings);
        validRows.push({
          date: load.date,
          vehicleNumber: vNum,
          weightKg: calc.weightKg,
          weightTons: calc.weightTons,
          customerTotalAmount: calc.customerTotalAmount,
          companyTotalAmount: calc.companyTotalAmount,
          rkrProfit: calc.rkrProfit,
          rkrProfitPerTon: calc.rkrProfitPerTon
        });
        existingSet.add(key);
      }
    }

    if (validRows.length > 0) {
      await prisma.transaction.createMany({
        data: validRows
      });
    }

    res.json({
      data: {
        totalRows: loads.length,
        validRows: validRows.length,
        uploadedRows: validRows.length,
        invalidRows: 0,
        duplicateRows: duplicateRows.length,
        failedRows: 0
      }
    });
  } catch (err) {
    console.error('BULK UPLOAD ERROR:', err);
    res.status(500).json({ error: String(err), message: err.message });
  }
});

// Dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const settings = await getSettings();
    const allTxs = await prisma.transaction.findMany({
      orderBy: { date: 'asc' }
    });

    const todayStr = getTodayISO();
    const weekStartStr = getWeekStartISO(todayStr);
    const monthStartStr = getMonthStartISO(todayStr);

    const whereSelected = buildWhereClause(req.query);
    const selectedTxs = (req.query.from || req.query.to)
      ? await prisma.transaction.findMany({ where: whereSelected })
      : allTxs;

    const aggregateArr = (arr) => {
      const totalKg = arr.reduce((acc, t) => acc + Number(t.weightKg || 0), 0);
      return calcAggregate(totalKg, arr.length, settings);
    };

    const overallTotals = aggregateArr(allTxs);
    const selectedTotals = aggregateArr(selectedTxs);

    const todayTxs = allTxs.filter(t => t.date === todayStr);
    const weekTxs = allTxs.filter(t => t.date >= weekStartStr && t.date <= todayStr);
    const monthTxs = allTxs.filter(t => t.date >= monthStartStr && t.date <= todayStr);

    const todayTotals = aggregateArr(todayTxs);
    const weekTotals = aggregateArr(weekTxs);
    const monthTotals = aggregateArr(monthTxs);

    // Build 14-day chart
    const chart = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const dayTxs = allTxs.filter(t => t.date === iso);
      const dayKg = dayTxs.reduce((acc, t) => acc + Number(t.weightKg || 0), 0);
      const dayTons = Number(toTons(dayKg).toNumber());
      const dayProfit = Number(money(dayTons * settings.rkrProfitPerTon).toNumber());

      chart.push({
        date: iso,
        tons: dayTons,
        rkrProfit: dayProfit
      });
    }

    const rangeLabel = req.query.from && req.query.to
      ? `${req.query.from} to ${req.query.to}`
      : 'All Time';

    res.json({
      data: {
        range: { label: rangeLabel, from: req.query.from || null, to: req.query.to || null },
        cards: {
          selected: selectedTotals,
          today: todayTotals,
          week: weekTotals,
          month: monthTotals,
          overall: overallTotals
        },
        rates: settings,
        capacity: settings.capacity,
        chart
      }
    });
  } catch (err) {
    console.error('DASHBOARD ERROR:', err);
    res.status(500).json({ error: String(err), message: err.message });
  }
});

// Helper for Report queries
async function handleReport(req, res) {
  try {
    const settings = await getSettings();
    const where = buildWhereClause(req.query);

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const totalKg = txs.reduce((a, b) => a + Number(b.weightKg || 0), 0);
    const totals = calcAggregate(totalKg, txs.length, settings);

    // Daily breakdown for Date-wise report
    const dayMap = {};
    for (const t of txs) {
      if (!dayMap[t.date]) {
        dayMap[t.date] = {
          date: t.date,
          dayName: getDayName(t.date),
          loadCount: 0,
          totalWeightKg: 0,
        };
      }
      dayMap[t.date].loadCount += 1;
      dayMap[t.date].totalWeightKg += Number(t.weightKg || 0);
    }

    const days = Object.values(dayMap)
      .sort((a, b) => (req.query.sort === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)))
      .map(d => {
        const dAgg = calcAggregate(d.totalWeightKg, d.loadCount, settings);
        return {
          date: d.date,
          dayName: d.dayName,
          loadCount: d.loadCount,
          totalWeightKg: dAgg.totalWeightKg,
          totalWeightTons: dAgg.totalWeightTons,
          customerTotalAmount: dAgg.customerTotalAmount,
          companyTotalAmount: dAgg.companyTotalAmount,
          rkrProfit: dAgg.rkrProfit
        };
      });

    const enrichedTxs = txs.map(t => enrichTransaction(t, settings));

    res.json({
      data: {
        range: { from: req.query.from || null, to: req.query.to || null },
        dayCount: days.length,
        days,
        totals,
        items: enrichedTxs
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

app.get('/api/reports/daily', handleReport);
app.get('/api/reports/weekly', handleReport);
app.get('/api/reports/monthly', handleReport);
app.get('/api/reports/overall', handleReport);

// Vehicles Report
app.get('/api/reports/vehicles', async (req, res) => {
  try {
    const settings = await getSettings();
    const where = buildWhereClause(req.query);
    const txs = await prisma.transaction.findMany({ where });

    const vMap = {};
    for (const t of txs) {
      const v = t.vehicleNumber;
      if (!vMap[v]) {
        vMap[v] = {
          vehicleNumber: v,
          loadCount: 0,
          totalWeightKg: 0,
        };
      }
      vMap[v].loadCount += 1;
      vMap[v].totalWeightKg += Number(t.weightKg || 0);
    }

    const vehicles = Object.values(vMap).map(v => {
      const agg = calcAggregate(v.totalWeightKg, v.loadCount, settings);
      return {
        vehicleNumber: v.vehicleNumber,
        loadCount: v.loadCount,
        totalWeightKg: agg.totalWeightKg,
        totalWeightTons: agg.totalWeightTons,
        customerTotalAmount: agg.customerTotalAmount,
        companyTotalAmount: agg.companyTotalAmount,
        rkrProfit: agg.rkrProfit
      };
    }).sort((a, b) => b.loadCount - a.loadCount);

    res.json({
      data: {
        vehicleCount: vehicles.length,
        vehicles
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// EXPORT ENDPOINT: 14 Columns with Full Financial Details
app.get('/api/export/excel', async (req, res) => {
  try {
    const settings = await getSettings();
    const where = buildWhereClause(req.query);

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }]
    });

    const enrichedRows = txs.map(t => enrichTransaction(t, settings));
    const totalKg = txs.reduce((a, b) => a + Number(b.weightKg || 0), 0);
    const totals = calcAggregate(totalKg, txs.length, settings);

    // Group daily for Date-wise Profit sheet
    const dayMap = {};
    for (const t of txs) {
      if (!dayMap[t.date]) {
        dayMap[t.date] = {
          date: t.date,
          dayName: getDayName(t.date),
          loadCount: 0,
          totalWeightKg: 0,
        };
      }
      dayMap[t.date].loadCount += 1;
      dayMap[t.date].totalWeightKg += Number(t.weightKg || 0);
    }

    const days = Object.values(dayMap)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(d => {
        const dAgg = calcAggregate(d.totalWeightKg, d.loadCount, settings);
        return {
          date: d.date,
          dayName: d.dayName,
          loadCount: d.loadCount,
          totalWeightKg: dAgg.totalWeightKg,
          totalWeightTons: dAgg.totalWeightTons,
          customerTotalAmount: dAgg.customerTotalAmount,
          companyTotalAmount: dAgg.companyTotalAmount,
          rkrProfit: dAgg.rkrProfit
        };
      });

    const rangeLabel = req.query.from && req.query.to
      ? `${req.query.from} to ${req.query.to}`
      : 'All Time';

    // If CSV explicitly requested
    if (req.query.format === 'csv') {
      const csv = buildCsv(enrichedRows, settings);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="RKR-Transactions.csv"');
      return res.send(csv);
    }

    // Build multi-sheet styled Excel workbook
    const buffer = await buildWorkbook({
      rows: enrichedRows,
      days,
      totals,
      settings,
      subtitle: `${rangeLabel}  |  ${enrichedRows.length} loads`
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="RKR-Transactions.xlsx"');
    res.setHeader('Content-Length', buffer.length);
    res.end(Buffer.from(buffer));
  } catch (err) {
    console.error('EXPORT ERROR:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Weekly Invoices Endpoints
app.get('/api/invoices', async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      orderBy: { generatedAt: 'desc' }
    });
    res.json({ data: invoices, total: invoices.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/invoices/preview', async (req, res) => {
  try {
    const settings = await getSettings();
    const weekOf = req.query.weekOf || getTodayISO();
    const start = getWeekStartISO(weekOf);
    const end = getWeekEndISO(weekOf);

    const txs = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const totalKg = txs.reduce((a, b) => a + Number(b.weightKg || 0), 0);
    const totals = calcAggregate(totalKg, txs.length, settings);

    res.json({
      data: {
        weekStart: start,
        weekEnd: end,
        totals,
        itemCount: txs.length,
        items: txs.map(t => enrichTransaction(t, settings))
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/invoices/generate', async (req, res) => {
  try {
    const { weekOf } = req.body;
    const settings = await getSettings();
    const start = getWeekStartISO(weekOf || getTodayISO());
    const end = getWeekEndISO(weekOf || getTodayISO());

    const existing = await prisma.invoice.findFirst({
      where: { weekOf: start }
    });

    if (existing && !req.body.regenerate) {
      return res.status(409).json({
        error: { message: `Invoice for week of ${start} already exists.` },
        details: { invoice: existing }
      });
    }

    const txs = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end } }
    });

    if (txs.length === 0) {
      return res.status(400).json({
        error: { message: `No loads found for week ${start} to ${end}.` }
      });
    }

    let invoice;
    if (existing) {
      invoice = existing;
    } else {
      invoice = await prisma.invoice.create({
        data: {
          weekOf: start,
          path: `RKR-${start}.xlsx`
        }
      });
    }

    res.json({
      message: 'Weekly invoice generated successfully.',
      data: invoice
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const settings = await getSettings();
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) {
      return res.status(404).json({ error: { message: 'Invoice not found.' } });
    }

    const start = invoice.weekOf;
    const end = getWeekEndISO(start);

    const txs = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const totalKg = txs.reduce((a, b) => a + Number(b.weightKg || 0), 0);
    const totals = calcAggregate(totalKg, txs.length, settings);

    res.json({
      data: {
        id: invoice.id,
        invoiceNumber: `${settings.invoicePrefix}${start}`,
        weekStart: start,
        weekEnd: end,
        totalLoads: txs.length,
        totalWeightKg: totals.totalWeightKg,
        totalWeightTons: totals.totalWeightTons,
        customerRatePerTon: totals.customerRatePerTon,
        customerGstRate: totals.customerGstRate,
        customerBaseAmount: totals.customerBaseAmount,
        customerGstAmount: totals.customerGstAmount,
        customerTotalAmount: totals.customerTotalAmount,
        companyRatePerTon: totals.companyRatePerTon,
        companyGstRate: totals.companyGstRate,
        companyBaseAmount: totals.companyBaseAmount,
        companyGstAmount: totals.companyGstAmount,
        companyTotalAmount: totals.companyTotalAmount,
        rkrProfitPerTon: totals.rkrProfitPerTon,
        rkrProfit: totals.rkrProfit,
        items: txs.map(t => enrichTransaction(t, settings))
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/invoices/:id/excel', async (req, res) => {
  try {
    const { id } = req.params;
    const settings = await getSettings();
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) {
      return res.status(404).json({ error: { message: 'Invoice not found.' } });
    }

    const start = invoice.weekOf;
    const end = getWeekEndISO(start);

    const txs = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const enrichedRows = txs.map(t => enrichTransaction(t, settings));
    const totalKg = txs.reduce((a, b) => a + Number(b.weightKg || 0), 0);
    const totals = calcAggregate(totalKg, txs.length, settings);

    const buffer = await buildWorkbook({
      rows: enrichedRows,
      totals,
      settings,
      subtitle: `Invoice ${settings.invoicePrefix}${start}  |  ${start} to ${end}`
    });

    const filename = `${settings.invoicePrefix}${start}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'RKR Backend' }));

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 8000;
  app.listen(PORT, () => {
    console.log(`RKR Backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
