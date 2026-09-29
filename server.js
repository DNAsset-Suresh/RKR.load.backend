const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Helper to get typed settings
async function getSettings() {
  const settingsArray = await prisma.setting.findMany();
  let raw = {};
  if (settingsArray.length === 0) {
    raw = {
      customerRatePerTon: '930', companyRatePerTon: '920', rkrProfitPerTon: '10',
      customerGstRate: '5', companyGstRate: '5', maximumLoads: '10000',
      businessName: 'RKR Enterprises', businessTagline: 'Logistics',
      businessAddress: 'Chennai, TN', businessPhone: '9876543210',
      businessEmail: 'info@rkrenterprises.com', invoicePrefix: 'RKR-'
    };
    for (const [key, value] of Object.entries(raw)) {
      await prisma.setting.create({ data: { key, value } });
    }
  } else {
    for (const s of settingsArray) { raw[s.key] = s.value; }
  }

  const num = (k) => Number(raw[k]);
  const loadCount = await prisma.transaction.count();
  
  return {
    customerRatePerTon: num('customerRatePerTon'),
    companyRatePerTon: num('companyRatePerTon'),
    rkrProfitPerTon: num('rkrProfitPerTon'),
    customerGstRate: num('customerGstRate'),
    companyGstRate: num('companyGstRate'),
    maximumLoads: num('maximumLoads'),
    businessName: raw.businessName,
    businessTagline: raw.businessTagline,
    businessAddress: raw.businessAddress,
    businessPhone: raw.businessPhone,
    businessEmail: raw.businessEmail,
    invoicePrefix: raw.invoicePrefix,
    capacity: { used: loadCount, remaining: Math.max(0, num('maximumLoads') - loadCount) }
  };
}

// Settings
app.get('/api/settings', async (req, res) => {
  res.json({ data: await getSettings() });
});

app.put('/api/settings', async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    await prisma.setting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) }
    });
  }
  res.json({ message: 'Settings updated successfully', data: await getSettings() });
});

// Transactions
app.post('/api/transactions/preview', async (req, res) => {
  const { weightKg } = req.body;
  const settings = await getSettings();
  const weightTons = weightKg / 1000;
  res.json({
    data: {
      weightKg, weightTons,
      customerTotalAmount: weightTons * settings.customerRatePerTon,
      companyTotalAmount: weightTons * settings.companyRatePerTon,
      rkrProfit: weightTons * settings.rkrProfitPerTon,
      rkrProfitPerTon: settings.rkrProfitPerTon
    }
  });
});

app.get('/api/transactions', async (req, res) => {
  const data = await prisma.transaction.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ data, total: data.length });
});

app.post('/api/transactions', async (req, res) => {
  const { date, vehicleNumber, weightKg } = req.body;
  const settings = await getSettings();
  const weightTons = weightKg / 1000;
  
  const newTx = await prisma.transaction.create({
    data: {
      date, vehicleNumber, weightKg, weightTons,
      customerTotalAmount: weightTons * settings.customerRatePerTon,
      companyTotalAmount: weightTons * settings.companyRatePerTon,
      rkrProfit: weightTons * settings.rkrProfitPerTon,
      rkrProfitPerTon: settings.rkrProfitPerTon
    }
  });
  res.json({ data: newTx });
});

app.post('/api/transactions/bulk', async (req, res) => {
  try {
    const { loads } = req.body;
    if (!Array.isArray(loads) || loads.length === 0) {
      return res.status(400).json({ error: 'No loads provided' });
    }

    const settings = await getSettings();
    const dates = [...new Set(loads.map(l => l.date))];
    const vehicleNumbers = [...new Set(loads.map(l => l.vehicleNumber))];

    // Find existing to prevent duplicates
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
      const key = `${load.date}_${load.vehicleNumber}_${load.weightKg}`;
      if (existingSet.has(key)) {
        duplicateRows.push(load);
      } else {
        const weightTons = load.weightKg / 1000;
        validRows.push({
          date: load.date,
          vehicleNumber: load.vehicleNumber,
          weightKg: load.weightKg,
          weightTons,
          customerTotalAmount: weightTons * settings.customerRatePerTon,
          companyTotalAmount: weightTons * settings.companyRatePerTon,
          rkrProfit: weightTons * settings.rkrProfitPerTon,
          rkrProfitPerTon: settings.rkrProfitPerTon
        });
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
        invalidRows: 0, // frontend handles invalid formats
        duplicateRows: duplicateRows.length,
        failedRows: 0
      }
    });
  } catch (err) {
    console.error("BULK UPLOAD ERROR:", err);
    res.status(500).json({ error: String(err), message: err.message });
  }
});

// Dashboard (Basic version)
app.get('/api/dashboard', async (req, res) => {
  try {
    const settings = await getSettings();
    const txs = await prisma.transaction.findMany();
    
    const sum = (arr) => ({
      loadCount: arr.length,
      totalWeightKg: arr.reduce((acc, t) => acc + t.weightKg, 0),
      totalWeightTons: arr.reduce((acc, t) => acc + t.weightTons, 0),
      customerTotalAmount: arr.reduce((acc, t) => acc + t.customerTotalAmount, 0),
      companyTotalAmount: arr.reduce((acc, t) => acc + t.companyTotalAmount, 0),
      rkrProfit: arr.reduce((acc, t) => acc + t.rkrProfit, 0),
      customerRatePerTon: settings.customerRatePerTon,
      companyRatePerTon: settings.companyRatePerTon,
      customerGstRate: settings.customerGstRate,
      companyGstRate: settings.companyGstRate
    });

    const totals = sum(txs);
    res.json({
      data: {
        range: { label: 'All Time', from: null, to: null },
        cards: { selected: totals, today: totals, week: totals, month: totals, overall: totals },
        rates: settings,
        capacity: settings.capacity,
        chart: []
      }
    });
  } catch (err) {
    console.error("DASHBOARD ERROR:", err);
    res.status(500).json({ error: String(err), message: err.message, stack: err.stack });
  }
});

// Mock remaining for now
const mockReports = (req, res) => res.json({ data: { loadCount: 0, totalWeightTons: 0, rkrProfit: 0, items: [] } });
app.get('/api/reports/daily', mockReports);
app.get('/api/reports/weekly', mockReports);
app.get('/api/reports/monthly', mockReports);
app.get('/api/reports/overall', mockReports);
app.get('/api/reports/vehicles', (req, res) => res.json({ data: [] }));

app.get('/api/invoices', (req, res) => res.json({ data: [], total: 0 }));
app.get('/api/invoices/:id', (req, res) => res.json({ data: { id: req.params.id, amount: 0, status: 'Draft' } }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/export/excel', async (req, res) => {
  try {
    const txs = await prisma.transaction.findMany({ orderBy: { date: 'desc' } });
    
    let csv = 'Date,Vehicle Number,Weight KG,Weight Tons,Customer Total,Company Total,RKR Profit\n';
    txs.forEach(t => {
      csv += `${t.date},${t.vehicleNumber},${t.weightKg},${t.weightTons},${t.customerTotalAmount},${t.companyTotalAmount},${t.rkrProfit}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="RKR-Transactions.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = 8000;
  app.listen(PORT, () => {
    console.log(`RKR Backend (Supabase) running on http://localhost:${PORT}`);
  });
}

module.exports = app;
