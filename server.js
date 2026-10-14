const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const {
  money,
  toTons,
  getMaterialRates,
  calcTransaction,
  calcAggregate,
  calcRowsAggregate,
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

function normalizeMaterial(m) {
  if (!m) return '40mm';
  const str = String(m).trim().toLowerCase();
  if (str === 'dust') return 'Dust';
  return '40mm';
}

// Helper to get typed settings with independent rate cards for 40mm and Dust
async function getSettings() {
  const settingsArray = await prisma.setting.findMany();
  let raw = {};
  for (const s of settingsArray) {
    raw[s.key] = s.value;
  }

  // Ensure default values for both 40mm and Dust rate cards without overwriting existing
  const defaults = {
    customerRatePerTon: '930',
    companyRatePerTon: '920',
    rkrProfitPerTon: '10',
    customerGstRate: '5',
    companyGstRate: '5',
    maximumLoads: '10000',
    dust_customerRatePerTon: '810',
    dust_companyRatePerTon: '800',
    dust_rkrProfitPerTon: '10',
    dust_customerGstRate: '5',
    dust_companyGstRate: '5',
    dust_maximumLoads: '10000',
    businessName: 'RKR ENTERPRISES',
    businessTagline: 'PLANNING | SOLUTIONS | GROWTH',
    businessAddress: 'Chennai, TN',
    businessPhone: '9876543210',
    businessEmail: 'info@rkrenterprises.com',
    invoicePrefix: 'RKR-'
  };

  for (const [key, val] of Object.entries(defaults)) {
    if (raw[key] === undefined) {
      raw[key] = val;
      await prisma.setting.upsert({
        where: { key },
        update: { value: val },
        create: { key, value: val }
      });
    }
  }

  const num = (k, def = 0) => (raw[k] !== undefined ? Number(raw[k]) : def);

  const count40mm = await prisma.transaction.count({
    where: { material: '40mm' }
  });
  const countDust = await prisma.transaction.count({
    where: { material: 'Dust' }
  });
  const totalLoads = count40mm + countDust;

  const max40mm = num('maximumLoads', 10000);
  const maxDust = num('dust_maximumLoads', 10000);

  const card40mm = {
    name: '40mm',
    material: '40mm',
    customerRatePerTon: num('customerRatePerTon', 930),
    companyRatePerTon: num('companyRatePerTon', 920),
    rkrProfitPerTon: num('rkrProfitPerTon', 10),
    customerGstRate: num('customerGstRate', 5),
    companyGstRate: num('companyGstRate', 5),
    maximumLoads: max40mm,
    capacity: {
      used: count40mm,
      remaining: Math.max(0, max40mm - count40mm),
      maximumLoads: max40mm
    }
  };

  const cardDust = {
    name: 'Dust',
    material: 'Dust',
    customerRatePerTon: raw.dust_customerRatePerTon !== undefined ? Number(raw.dust_customerRatePerTon) : (raw.dustCustomerRatePerTon !== undefined ? Number(raw.dustCustomerRatePerTon) : 810),
    companyRatePerTon: raw.dust_companyRatePerTon !== undefined ? Number(raw.dust_companyRatePerTon) : (raw.dustCompanyRatePerTon !== undefined ? Number(raw.dustCompanyRatePerTon) : 800),
    rkrProfitPerTon: raw.dust_rkrProfitPerTon !== undefined ? Number(raw.dust_rkrProfitPerTon) : (raw.dustRkrProfitPerTon !== undefined ? Number(raw.dustRkrProfitPerTon) : 10),
    customerGstRate: raw.dust_customerGstRate !== undefined ? Number(raw.dust_customerGstRate) : (raw.dustCustomerGstRate !== undefined ? Number(raw.dustCustomerGstRate) : 5),
    companyGstRate: raw.dust_companyGstRate !== undefined ? Number(raw.dust_companyGstRate) : (raw.dustCompanyGstRate !== undefined ? Number(raw.dustCompanyGstRate) : 5),
    maximumLoads: maxDust,
    capacity: {
      used: countDust,
      remaining: Math.max(0, maxDust - countDust),
      maximumLoads: maxDust
    }
  };

  return {
    ...card40mm, // default / backward compatible
    materials: {
      '40mm': card40mm,
      'Dust': cardDust
    },
    '40mm': card40mm,
    'Dust': cardDust,
    businessName: raw.businessName || 'RKR ENTERPRISES',
    businessTagline: raw.businessTagline || 'Logistics',
    businessAddress: raw.businessAddress || 'Chennai, TN',
    businessPhone: raw.businessPhone || '9876543210',
    businessEmail: raw.businessEmail || 'info@rkrenterprises.com',
    invoicePrefix: raw.invoicePrefix || 'RKR-',
    capacity: {
      used: totalLoads,
      remaining: Math.max(0, (max40mm + maxDust) - totalLoads),
      maximumLoads: max40mm + maxDust
    }
  };
}

// Build where clause from query parameters, including material
function buildWhereClause(query) {
  const { from, to, vehicle, date, material } = query;
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

  if (material && material !== 'All' && material !== 'all') {
    const mat = normalizeMaterial(material);
    where.material = mat;
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
      if (value !== undefined && value !== null) {
        await prisma.setting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) }
        });
      }
    }
    res.json({ message: 'Settings updated successfully', data: await getSettings() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Transactions Preview (Material-aware)
app.post('/api/transactions/preview', async (req, res) => {
  try {
    const { weightKg, material } = req.body;
    const settings = await getSettings();
    const result = calcTransaction(weightKg, settings, material || '40mm');
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Transactions List (Material-aware)
app.get('/api/transactions', async (req, res) => {
  try {
    const settings = await getSettings();
    const where = buildWhereClause(req.query);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize || req.query.limit, 10) || 50);

    // Get all matching transactions
    const allMatching = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }]
    });

    const enrichedAll = allMatching.map(t => enrichTransaction(t, settings));
    const totalCount = enrichedAll.length;
    const totals = calcRowsAggregate(enrichedAll, settings, req.query.material);

    // Paginate
    const skip = (page - 1) * pageSize;
    const paginated = enrichedAll.slice(skip, skip + pageSize);

    res.json({
      data: paginated,
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

// Create Transaction (Material-aware)
app.post('/api/transactions', async (req, res) => {
  try {
    const { date, vehicleNumber, weightKg, material } = req.body;
    const mat = normalizeMaterial(material);
    const settings = await getSettings();

    // Check material capacity limit
    const card = settings.materials[mat];
    if (card && card.capacity && card.capacity.remaining <= 0) {
      return res.status(400).json({
        error: { message: `Maximum load entries reached for ${mat} (${card.maximumLoads}). Export and archive first.` }
      });
    }

    const calc = calcTransaction(weightKg, settings, mat);

    const newTx = await prisma.transaction.create({
      data: {
        date,
        vehicleNumber: (vehicleNumber || '').trim().toUpperCase(),
        material: mat,
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

// Update Transaction (Material-aware)
app.put('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { date, vehicleNumber, weightKg, material } = req.body;
    const mat = normalizeMaterial(material);
    const settings = await getSettings();
    const calc = calcTransaction(weightKg, settings, mat);

    const updated = await prisma.transaction.update({
      where: { id },
      data: {
        date,
        vehicleNumber: (vehicleNumber || '').trim().toUpperCase(),
        material: mat,
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

// Bulk Upload Transactions (Material-aware)
app.post('/api/transactions/bulk', async (req, res) => {
  try {
    const { loads, defaultMaterial } = req.body;
    if (!Array.isArray(loads) || loads.length === 0) {
      return res.status(400).json({ error: 'No loads provided' });
    }

    const fallbackMat = normalizeMaterial(defaultMaterial || '40mm');
    const settings = await getSettings();
    const dates = [...new Set(loads.map(l => l.date))];
    const vehicleNumbers = [...new Set(loads.map(l => (l.vehicleNumber || '').trim().toUpperCase()))];

    const existingTxs = await prisma.transaction.findMany({
      where: {
        date: { in: dates },
        vehicleNumber: { in: vehicleNumbers }
      },
      select: { date: true, vehicleNumber: true, weightKg: true, material: true }
    });

    const existingSet = new Set(
      existingTxs.map(t => `${t.date}_${t.vehicleNumber}_${t.weightKg}_${t.material || '40mm'}`)
    );

    const validRows = [];
    const duplicateRows = [];

    for (const load of loads) {
      const vNum = (load.vehicleNumber || '').trim().toUpperCase();
      const mat = normalizeMaterial(load.material || fallbackMat);
      const key = `${load.date}_${vNum}_${load.weightKg}_${mat}`;

      if (existingSet.has(key)) {
        duplicateRows.push(load);
      } else {
        const calc = calcTransaction(load.weightKg, settings, mat);
        validRows.push({
          date: load.date,
          vehicleNumber: vNum,
          material: mat,
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

// Dashboard (Material-aware)
app.get('/api/dashboard', async (req, res) => {
  try {
    const settings = await getSettings();
    const matFilter = req.query.material || 'All';
    const whereBase = buildWhereClause({ material: matFilter });

    const allMatching = await prisma.transaction.findMany({
      where: whereBase,
      orderBy: { date: 'asc' }
    });

    const enrichedAll = allMatching.map(t => enrichTransaction(t, settings));

    const todayStr = getTodayISO();
    const weekStartStr = getWeekStartISO(todayStr);
    const monthStartStr = getMonthStartISO(todayStr);

    const whereSelected = buildWhereClause(req.query);
    const selectedTxs = (req.query.from || req.query.to)
      ? (await prisma.transaction.findMany({ where: whereSelected })).map(t => enrichTransaction(t, settings))
      : enrichedAll;

    const overallTotals = calcRowsAggregate(enrichedAll, settings, matFilter);
    const selectedTotals = calcRowsAggregate(selectedTxs, settings, matFilter);

    const todayTxs = enrichedAll.filter(t => t.date === todayStr);
    const weekTxs = enrichedAll.filter(t => t.date >= weekStartStr && t.date <= todayStr);
    const monthTxs = enrichedAll.filter(t => t.date >= monthStartStr && t.date <= todayStr);

    const todayTotals = calcRowsAggregate(todayTxs, settings, matFilter);
    const weekTotals = calcRowsAggregate(weekTxs, settings, matFilter);
    const monthTotals = calcRowsAggregate(monthTxs, settings, matFilter);

    // Build 14-day chart
    const chart = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const dayTxs = enrichedAll.filter(t => t.date === iso);
      const dayTons = dayTxs.reduce((acc, t) => acc + Number(t.weightTons || 0), 0);
      const dayProfit = dayTxs.reduce((acc, t) => acc + Number(t.rkrProfit || 0), 0);

      chart.push({
        date: iso,
        tons: Number(dayTons.toFixed(3)),
        rkrProfit: Number(dayProfit.toFixed(2))
      });
    }

    const rangeLabel = req.query.from && req.query.to
      ? `${req.query.from} to ${req.query.to}`
      : 'All Time';

    const activeRateCard = matFilter !== 'All' ? getMaterialRates(settings, matFilter) : settings;

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
        rates: activeRateCard,
        materials: settings.materials,
        capacity: matFilter !== 'All' && settings.materials[matFilter]
          ? settings.materials[matFilter].capacity
          : settings.capacity,
        chart
      }
    });
  } catch (err) {
    console.error('DASHBOARD ERROR:', err);
    res.status(500).json({ error: String(err), message: err.message });
  }
});

// Helper for Report queries (Material-aware)
async function handleReport(req, res) {
  try {
    const settings = await getSettings();
    const matFilter = req.query.material || 'All';
    const where = buildWhereClause(req.query);

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const enrichedTxs = txs.map(t => enrichTransaction(t, settings));
    const totals = calcRowsAggregate(enrichedTxs, settings, matFilter);

    // Daily breakdown for Date-wise report
    const dayMap = {};
    for (const t of enrichedTxs) {
      if (!dayMap[t.date]) {
        dayMap[t.date] = {
          date: t.date,
          dayName: getDayName(t.date),
          items: []
        };
      }
      dayMap[t.date].items.push(t);
    }

    const days = Object.values(dayMap)
      .sort((a, b) => (req.query.sort === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)))
      .map(d => {
        const dAgg = calcRowsAggregate(d.items, settings, matFilter);
        return {
          date: d.date,
          dayName: d.dayName,
          loadCount: dAgg.loadCount,
          totalWeightKg: dAgg.totalWeightKg,
          totalWeightTons: dAgg.totalWeightTons,
          customerTotalAmount: dAgg.customerTotalAmount,
          companyTotalAmount: dAgg.companyTotalAmount,
          rkrProfit: dAgg.rkrProfit
        };
      });

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

// Vehicles Report (Material-aware)
app.get('/api/reports/vehicles', async (req, res) => {
  try {
    const settings = await getSettings();
    const matFilter = req.query.material || 'All';
    const where = buildWhereClause(req.query);
    const txs = await prisma.transaction.findMany({ where });
    const enrichedTxs = txs.map(t => enrichTransaction(t, settings));

    const vMap = {};
    for (const t of enrichedTxs) {
      const v = t.vehicleNumber;
      if (!vMap[v]) {
        vMap[v] = {
          vehicleNumber: v,
          items: []
        };
      }
      vMap[v].items.push(t);
    }

    const vehicles = Object.values(vMap).map(v => {
      const agg = calcRowsAggregate(v.items, settings, matFilter);
      return {
        vehicleNumber: v.vehicleNumber,
        loadCount: agg.loadCount,
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

// EXPORT ENDPOINT: Material + 14 Columns with Full Financial Details
app.get('/api/export/excel', async (req, res) => {
  try {
    const settings = await getSettings();
    const matFilter = req.query.material || 'All';
    const where = buildWhereClause(req.query);

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }]
    });

    const enrichedRows = txs.map(t => enrichTransaction(t, settings));
    const totals = calcRowsAggregate(enrichedRows, settings, matFilter);

    // Group daily for Date-wise Profit sheet
    const dayMap = {};
    for (const t of enrichedRows) {
      if (!dayMap[t.date]) {
        dayMap[t.date] = {
          date: t.date,
          dayName: getDayName(t.date),
          items: []
        };
      }
      dayMap[t.date].items.push(t);
    }

    const days = Object.values(dayMap)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(d => {
        const dAgg = calcRowsAggregate(d.items, settings, matFilter);
        return {
          date: d.date,
          dayName: d.dayName,
          loadCount: dAgg.loadCount,
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

    const matSuffix = matFilter !== 'All' ? `-${matFilter}` : '';

    // If CSV explicitly requested
    if (req.query.format === 'csv') {
      const csv = buildCsv(enrichedRows, settings);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="RKR-Transactions${matSuffix}.csv"`);
      return res.send(csv);
    }

    // Build multi-sheet styled Excel workbook
    const buffer = await buildWorkbook({
      rows: enrichedRows,
      days,
      totals,
      settings,
      materialFilter: matFilter,
      subtitle: `${rangeLabel}  |  ${enrichedRows.length} loads (${matFilter})`
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="RKR-Transactions${matSuffix}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(Buffer.from(buffer));
  } catch (err) {
    console.error('EXPORT ERROR:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Weekly Invoices Endpoints (Material-aware)
app.get('/api/invoices', async (req, res) => {
  try {
    const matFilter = req.query.material;
    let where = {};
    if (matFilter && matFilter !== 'All') {
      where.material = matFilter;
    }
    const invoices = await prisma.invoice.findMany({
      where,
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
    const matFilter = req.query.material || 'All';
    const start = getWeekStartISO(weekOf);
    const end = getWeekEndISO(weekOf);

    const where = { date: { gte: start, lte: end } };
    if (matFilter && matFilter !== 'All') {
      where.material = normalizeMaterial(matFilter);
    }

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const enriched = txs.map(t => enrichTransaction(t, settings));
    const totals = calcRowsAggregate(enriched, settings, matFilter);

    res.json({
      data: {
        weekStart: start,
        weekEnd: end,
        material: matFilter,
        totals,
        itemCount: enriched.length,
        items: enriched
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/invoices/generate', async (req, res) => {
  try {
    const { weekOf, material, regenerate } = req.body;
    const mat = material && material !== 'All' ? normalizeMaterial(material) : 'All';
    const settings = await getSettings();
    const start = getWeekStartISO(weekOf || getTodayISO());
    const end = getWeekEndISO(weekOf || getTodayISO());

    const whereExisting = { weekOf: start };
    if (mat !== 'All') {
      whereExisting.material = mat;
    }

    const existing = await prisma.invoice.findFirst({
      where: whereExisting
    });

    if (existing && !regenerate) {
      return res.status(409).json({
        error: { message: `Invoice for week of ${start} (${mat}) already exists.` },
        details: { invoice: existing }
      });
    }

    const whereTxs = { date: { gte: start, lte: end } };
    if (mat !== 'All') {
      whereTxs.material = mat;
    }

    const txs = await prisma.transaction.findMany({ where: whereTxs });

    if (txs.length === 0) {
      return res.status(400).json({
        error: { message: `No ${mat === 'All' ? '' : mat + ' '}loads found for week ${start} to ${end}.` }
      });
    }

    let invoice;
    if (existing) {
      invoice = existing;
    } else {
      invoice = await prisma.invoice.create({
        data: {
          weekOf: start,
          material: mat,
          path: `RKR-${start}-${mat}.xlsx`
        }
      });
    }

    res.json({
      message: `Weekly invoice generated successfully for ${mat}.`,
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
    const mat = invoice.material || 'All';

    const where = { date: { gte: start, lte: end } };
    if (mat !== 'All') {
      where.material = mat;
    }

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const enriched = txs.map(t => enrichTransaction(t, settings));
    const totals = calcRowsAggregate(enriched, settings, mat);

    res.json({
      data: {
        id: invoice.id,
        invoiceNumber: `${settings.invoicePrefix}${start}${mat !== 'All' ? '-' + mat : ''}`,
        weekStart: start,
        weekEnd: end,
        material: mat,
        totalLoads: enriched.length,
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
        items: enriched
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
    const mat = invoice.material || 'All';

    const where = { date: { gte: start, lte: end } };
    if (mat !== 'All') {
      where.material = mat;
    }

    const txs = await prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }]
    });

    const enrichedRows = txs.map(t => enrichTransaction(t, settings));
    const totals = calcRowsAggregate(enrichedRows, settings, mat);

    const buffer = await buildWorkbook({
      rows: enrichedRows,
      totals,
      settings,
      materialFilter: mat,
      subtitle: `Invoice ${settings.invoicePrefix}${start} (${mat})  |  ${start} to ${end}`
    });

    const filename = `${settings.invoicePrefix}${start}${mat !== 'All' ? '-' + mat : ''}.xlsx`;
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
