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

// Dashboard (Basic version)
app.get('/api/dashboard', async (req, res) => {
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

const PORT = 8000;
app.listen(PORT, () => {
  console.log(`RKR Backend (Supabase) running on http://localhost:${PORT}`);
});
