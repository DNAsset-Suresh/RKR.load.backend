const ExcelJS = require('exceljs');
const { calcAggregate } = require('./calc');

const NAVY = 'FF0A1B3D';
const GOLD = 'FFC9A24B';
const GOLD_LIGHT = 'FFF3E7CC';
const SOFT = 'FFF2F5FA';

const INR = '"Rs "##,##0.00';
const KGFMT = '#,##0';
const TONFMT = '#,##0.000';

const COLUMNS = [
  { header: 'Date', key: 'date', width: 13 },
  { header: 'Vehicle Number', key: 'vehicleNumber', width: 20 },
  { header: 'Weight KG', key: 'weightKg', width: 14, fmt: KGFMT },
  { header: 'Weight Tons', key: 'weightTons', width: 14, fmt: TONFMT },
  { header: 'Customer Rate/Ton', key: 'customerRatePerTon', width: 17, fmt: INR },
  { header: 'Customer GST', key: 'customerGstAmount', width: 15, fmt: INR },
  { header: 'Customer Base Amount', key: 'customerBaseAmount', width: 20, fmt: INR },
  { header: 'Customer Total', key: 'customerTotalAmount', width: 16, fmt: INR },
  { header: 'Company Rate/Ton', key: 'companyRatePerTon', width: 17, fmt: INR },
  { header: 'Company GST', key: 'companyGstAmount', width: 15, fmt: INR },
  { header: 'Company Base Amount', key: 'companyBaseAmount', width: 20, fmt: INR },
  { header: 'Company Total', key: 'companyTotalAmount', width: 16, fmt: INR },
  { header: 'RKR Rate/Ton', key: 'rkrProfitPerTon', width: 14, fmt: INR },
  { header: 'RKR Profit', key: 'rkrProfit', width: 15, fmt: INR },
];

function styleHeader(row) {
  row.height = 26;
  row.eachCell(function (cell, col) {
    const isRkr = col >= 13;
    cell.font = { bold: true, size: 10, color: { argb: isRkr ? NAVY : 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isRkr ? GOLD : NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

function titleBlock(sheet, settings, title, subtitle, span) {
  sheet.mergeCells(1, 1, 1, span);
  const t = sheet.getCell('A1');
  t.value = (settings.businessName || 'RKR Enterprises') + '  -  ' + title;
  t.font = { bold: true, size: 15, color: { argb: NAVY } };

  sheet.mergeCells(2, 1, 2, span);
  const s = sheet.getCell('A2');
  s.value = subtitle;
  s.font = { italic: true, size: 10, color: { argb: 'FF5B6478' } };
}

/** Transaction sheet with all 14 spec columns plus a TOTAL row. */
function addTransactionSheet(wb, rows, settings, meta) {
  const sheet = wb.addWorksheet('Transactions', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  titleBlock(sheet, settings, 'TRANSACTIONS', meta.subtitle || `${rows.length} loads`, COLUMNS.length);
  sheet.addRow([]);

  const header = sheet.addRow(COLUMNS.map(function (c) { return c.header; }));
  styleHeader(header);
  COLUMNS.forEach(function (c, i) { sheet.getColumn(i + 1).width = c.width; });

  rows.forEach(function (r) {
    const row = sheet.addRow(COLUMNS.map(function (c) {
      if (c.key === 'date') return r.date;
      if (c.key === 'vehicleNumber') return r.vehicleNumber;
      return Number(r[c.key] || 0);
    }));

    COLUMNS.forEach(function (c, i) {
      if (c.fmt) row.getCell(i + 1).numFmt = c.fmt;
      if (i >= 12) {
        row.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_LIGHT } };
      }
    });
  });

  // Totals recomputed from summed KG
  const totalKg = rows.reduce(function (a, r) { return a + Number(r.weightKg || 0); }, 0);
  const t = calcAggregate(totalKg, rows.length, settings);

  sheet.addRow([]);
  const total = sheet.addRow([
    'TOTAL', rows.length + ' loads',
    Number(t.totalWeightKg), Number(t.totalWeightTons),
    Number(t.customerRatePerTon), Number(t.customerGstAmount),
    Number(t.customerBaseAmount), Number(t.customerTotalAmount),
    Number(t.companyRatePerTon), Number(t.companyGstAmount),
    Number(t.companyBaseAmount), Number(t.companyTotalAmount),
    Number(t.rkrProfitPerTon), Number(t.rkrProfit),
  ]);

  total.eachCell(function (cell, col) {
    cell.font = { bold: true, color: { argb: NAVY } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col >= 13 ? GOLD_LIGHT : SOFT } };
    const c = COLUMNS[col - 1];
    if (c && c.fmt) cell.numFmt = c.fmt;
  });

  return sheet;
}

/** Date-wise profit sheet: one row per day. */
function addDailySheet(wb, days, settings, meta) {
  if (!days || days.length === 0) return;
  const sheet = wb.addWorksheet('Date-wise Profit', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  const cols = [
    { h: 'Date', w: 13 }, { h: 'Day', w: 13 }, { h: 'Loads', w: 10 },
    { h: 'Weight KG', w: 14, f: KGFMT }, { h: 'Weight Tons', w: 14, f: TONFMT },
    { h: 'Customer Total', w: 16, f: INR }, { h: 'Company Total', w: 16, f: INR },
    { h: 'RKR Profit', w: 15, f: INR },
  ];

  titleBlock(sheet, settings, 'DATE-WISE PROFIT', meta.subtitle || `${days.length} days`, cols.length);
  sheet.addRow([]);

  const header = sheet.addRow(cols.map(function (c) { return c.h; }));
  header.height = 24;
  header.eachCell(function (cell, col) {
    const isRkr = col === cols.length;
    cell.font = { bold: true, size: 10, color: { argb: isRkr ? NAVY : 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isRkr ? GOLD : NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  cols.forEach(function (c, i) { sheet.getColumn(i + 1).width = c.w; });

  days.forEach(function (d) {
    const row = sheet.addRow([
      d.date, d.dayName, d.loadCount,
      d.totalWeightKg, d.totalWeightTons,
      d.customerTotalAmount, d.companyTotalAmount, d.rkrProfit,
    ]);
    cols.forEach(function (c, i) { if (c.f) row.getCell(i + 1).numFmt = c.f; });
    row.getCell(cols.length).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_LIGHT } };
  });

  if (meta.totals) {
    sheet.addRow([]);
    const total = sheet.addRow([
      'TOTAL', days.length + ' days', meta.totals.loadCount,
      meta.totals.totalWeightKg, meta.totals.totalWeightTons,
      meta.totals.customerTotalAmount, meta.totals.companyTotalAmount, meta.totals.rkrProfit,
    ]);
    total.eachCell(function (cell, col) {
      cell.font = { bold: true, color: { argb: NAVY } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col === cols.length ? GOLD_LIGHT : SOFT } };
      const c = cols[col - 1];
      if (c && c.f) cell.numFmt = c.f;
    });
  }

  return sheet;
}

/** Summary sheet stating all key financial totals and rules. */
function addSummarySheet(wb, settings, meta) {
  const sheet = wb.addWorksheet('Summary');
  sheet.getColumn(1).width = 30;
  sheet.getColumn(2).width = 24;
  titleBlock(sheet, settings, 'SUMMARY', meta.subtitle || 'All Time', 2);
  sheet.addRow([]);

  const t = meta.totals;
  if (!t) return sheet;

  const lines = [
    ['Total Loads', t.loadCount, '#,##0'],
    ['Total Weight KG', t.totalWeightKg, KGFMT],
    ['Total Weight Tons', t.totalWeightTons, TONFMT],
    [null, null, null],
    ['Customer Rate / Ton', t.customerRatePerTon, INR],
    ['Customer Base Amount', t.customerBaseAmount, INR],
    ['Customer GST', t.customerGstAmount, INR],
    ['Customer Total', t.customerTotalAmount, INR],
    [null, null, null],
    ['Company Rate / Ton', t.companyRatePerTon, INR],
    ['Company Base Amount', t.companyBaseAmount, INR],
    ['Company GST', t.companyGstAmount, INR],
    ['Company Total', t.companyTotalAmount, INR],
    [null, null, null],
    ['RKR Rate / Ton', t.rkrProfitPerTon, INR],
    ['RKR PROFIT', t.rkrProfit, INR],
  ];

  lines.forEach(function (l) {
    if (!l[0]) { sheet.addRow([]); return; }
    const row = sheet.addRow([l[0], l[1]]);
    row.getCell(1).font = { bold: l[0] === 'RKR PROFIT', color: { argb: NAVY } };
    row.getCell(2).numFmt = l[2];
    if (l[0] === 'RKR PROFIT') {
      row.getCell(2).font = { bold: true, size: 13, color: { argb: NAVY } };
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_LIGHT } };
    }
  });

  sheet.addRow([]);
  const note = sheet.addRow(['Rule:  KG / 1000 = TONS,  then TONS x rate. Never per vehicle.']);
  note.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF5B6478' } };
  return sheet;
}

/** Build full workbook buffer */
async function buildWorkbook(options) {
  const wb = new ExcelJS.Workbook();
  wb.creator = options.settings.businessName || 'RKR Enterprises';
  wb.created = new Date();

  addSummarySheet(wb, options.settings, options);
  if (options.days && options.days.length > 0) {
    addDailySheet(wb, options.days, options.settings, options);
  }
  addTransactionSheet(wb, options.rows, options.settings, options);

  return await wb.xlsx.writeBuffer();
}

/** CSV generator containing all 14 columns */
function buildCsv(rows, settings) {
  const headers = COLUMNS.map(c => c.header).join(',');
  let csv = headers + '\n';

  rows.forEach(r => {
    const line = COLUMNS.map(c => {
      const val = r[c.key] !== undefined ? r[c.key] : '';
      if (typeof val === 'string' && val.includes(',')) {
        return `"${val}"`;
      }
      return val;
    }).join(',');
    csv += line + '\n';
  });

  return csv;
}

module.exports = {
  buildWorkbook,
  buildCsv,
  COLUMNS,
};
