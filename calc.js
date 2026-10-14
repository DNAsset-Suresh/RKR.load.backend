const Decimal = require('decimal.js');

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

const KG_PER_TON = new Decimal(1000);
const MONEY_DP = 2; // paise precision
const TON_DP = 3;   // 1 kg = 0.001 t

/** Round to paise, half-up. */
function money(value) {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

/** KG -> TONS. */
function toTons(weightKg) {
  return new Decimal(weightKg)
    .div(KG_PER_TON)
    .toDecimalPlaces(TON_DP, Decimal.ROUND_HALF_UP);
}

/**
 * One billing leg: base = tons x rate, gst = base x rate%, total = base + gst.
 * Base and GST are each rounded to paise BEFORE being added.
 */
function leg(tons, ratePerTon, gstRatePercent) {
  const base = money(new Decimal(tons).mul(ratePerTon));
  const gst = money(base.mul(gstRatePercent).div(100));
  return { base, gst, total: base.plus(gst) };
}

/** Resolves the rate card for a given material ('40mm' or 'Dust') */
function getMaterialRates(settings, material = '40mm') {
  const norm = (material || '40mm').toLowerCase() === 'dust' ? 'Dust' : '40mm';
  if (norm === 'Dust') {
    const card = settings?.materials?.Dust || settings?.Dust || {};
    return {
      material: 'Dust',
      customerRatePerTon: Number(card.customerRatePerTon ?? settings?.dust_customerRatePerTon ?? settings?.dustCustomerRatePerTon ?? 810),
      companyRatePerTon: Number(card.companyRatePerTon ?? settings?.dust_companyRatePerTon ?? settings?.dustCompanyRatePerTon ?? 800),
      rkrProfitPerTon: Number(card.rkrProfitPerTon ?? settings?.dust_rkrProfitPerTon ?? settings?.dustRkrProfitPerTon ?? 10),
      customerGstRate: Number(card.customerGstRate ?? settings?.dust_customerGstRate ?? settings?.dustCustomerGstRate ?? 5),
      companyGstRate: Number(card.companyGstRate ?? settings?.dust_companyGstRate ?? settings?.dustCompanyGstRate ?? 5),
      maximumLoads: Number(card.maximumLoads ?? settings?.dust_maximumLoads ?? settings?.dustMaximumLoads ?? 10000),
    };
  }

  const card = settings?.materials?.['40mm'] || settings?.['40mm'] || {};
  return {
    material: '40mm',
    customerRatePerTon: Number(card.customerRatePerTon ?? settings?.customerRatePerTon ?? 930),
    companyRatePerTon: Number(card.companyRatePerTon ?? settings?.companyRatePerTon ?? 920),
    rkrProfitPerTon: Number(card.rkrProfitPerTon ?? settings?.rkrProfitPerTon ?? 10),
    customerGstRate: Number(card.customerGstRate ?? settings?.customerGstRate ?? 5),
    companyGstRate: Number(card.companyGstRate ?? settings?.companyGstRate ?? 5),
    maximumLoads: Number(card.maximumLoads ?? settings?.maximumLoads ?? 10000),
  };
}

/**
 * Full calculation for a single load.
 */
function calcTransaction(weightKg, settings, material = '40mm') {
  const rates = getMaterialRates(settings, material);
  const kg = new Decimal(weightKg || 0);
  const tons = toTons(kg);

  const customer = leg(tons, rates.customerRatePerTon, rates.customerGstRate);
  const company = leg(tons, rates.companyRatePerTon, rates.companyGstRate);

  const rkrProfitRate = new Decimal(rates.rkrProfitPerTon);
  const rkrProfit = money(tons.mul(rkrProfitRate));

  return {
    material: rates.material,
    weightKg: kg.toNumber(),
    weightTons: tons.toNumber(),

    customerRatePerTon: rates.customerRatePerTon,
    customerGstRate: rates.customerGstRate,
    customerBaseAmount: customer.base.toNumber(),
    customerGstAmount: customer.gst.toNumber(),
    customerTotalAmount: customer.total.toNumber(),

    companyRatePerTon: rates.companyRatePerTon,
    companyGstRate: rates.companyGstRate,
    companyBaseAmount: company.base.toNumber(),
    companyGstAmount: company.gst.toNumber(),
    companyTotalAmount: company.total.toNumber(),

    rkrProfitPerTon: rkrProfitRate.toNumber(),
    rkrProfit: rkrProfit.toNumber(),
  };
}

/**
 * Aggregates a list of enriched transactions.
 * Works seamlessly for a single material or mixed materials (All Materials).
 */
function calcRowsAggregate(enrichedRows = [], settings, materialFilter = 'All') {
  let totalKg = 0;
  let totalTons = 0;
  let custBase = 0;
  let custGst = 0;
  let custTotal = 0;
  let compBase = 0;
  let compGst = 0;
  let compTotal = 0;
  let rkrProfit = 0;

  for (const r of enrichedRows) {
    totalKg += Number(r.weightKg || 0);
    totalTons += Number(r.weightTons || 0);
    custBase += Number(r.customerBaseAmount || 0);
    custGst += Number(r.customerGstAmount || 0);
    custTotal += Number(r.customerTotalAmount || 0);
    compBase += Number(r.companyBaseAmount || 0);
    compGst += Number(r.companyGstAmount || 0);
    compTotal += Number(r.companyTotalAmount || 0);
    rkrProfit += Number(r.rkrProfit || 0);
  }

  const rates = (materialFilter && materialFilter !== 'All')
    ? getMaterialRates(settings, materialFilter)
    : null;

  return {
    material: materialFilter || 'All',
    loadCount: enrichedRows.length,
    totalWeightKg: Math.round(totalKg),
    totalWeightTons: Number(totalTons.toFixed(3)),
    customerRatePerTon: rates ? rates.customerRatePerTon : (settings?.customerRatePerTon || 930),
    customerGstRate: rates ? rates.customerGstRate : 5,
    customerBaseAmount: Number(custBase.toFixed(2)),
    customerGstAmount: Number(custGst.toFixed(2)),
    customerTotalAmount: Number(custTotal.toFixed(2)),
    companyRatePerTon: rates ? rates.companyRatePerTon : (settings?.companyRatePerTon || 920),
    companyGstRate: rates ? rates.companyGstRate : 5,
    companyBaseAmount: Number(compBase.toFixed(2)),
    companyGstAmount: Number(compGst.toFixed(2)),
    companyTotalAmount: Number(compTotal.toFixed(2)),
    rkrProfitPerTon: rates ? rates.rkrProfitPerTon : 10,
    rkrProfit: Number(rkrProfit.toFixed(2)),
  };
}

/**
 * Period totals recomputed from summed KG for a single material.
 */
function calcAggregate(totalWeightKg, loadCount, settings, material = '40mm') {
  const r = calcTransaction(totalWeightKg, settings, material);
  return {
    material: r.material,
    loadCount: Number(loadCount || 0),
    totalWeightKg: r.weightKg,
    totalWeightTons: r.weightTons,
    customerRatePerTon: r.customerRatePerTon,
    customerGstRate: r.customerGstRate,
    customerBaseAmount: r.customerBaseAmount,
    customerGstAmount: r.customerGstAmount,
    customerTotalAmount: r.customerTotalAmount,
    companyRatePerTon: r.companyRatePerTon,
    companyGstRate: r.companyGstRate,
    companyBaseAmount: r.companyBaseAmount,
    companyGstAmount: r.companyGstAmount,
    companyTotalAmount: r.companyTotalAmount,
    rkrProfitPerTon: r.rkrProfitPerTon,
    rkrProfit: r.rkrProfit,
  };
}

/** Enriches any raw transaction from DB with all 14 calculated fields */
function enrichTransaction(t, settings) {
  const mat = t.material || '40mm';
  const calc = calcTransaction(t.weightKg, settings, mat);

  return {
    ...t,
    material: mat,
    weightKg: calc.weightKg,
    weightTons: calc.weightTons,
    customerRatePerTon: calc.customerRatePerTon,
    customerGstRate: calc.customerGstRate,
    customerBaseAmount: calc.customerBaseAmount,
    customerGstAmount: calc.customerGstAmount,
    customerTotalAmount: calc.customerTotalAmount,
    companyRatePerTon: calc.companyRatePerTon,
    companyGstRate: calc.companyGstRate,
    companyBaseAmount: calc.companyBaseAmount,
    companyGstAmount: calc.companyGstAmount,
    companyTotalAmount: calc.companyTotalAmount,
    rkrProfitPerTon: calc.rkrProfitPerTon,
    rkrProfit: calc.rkrProfit,
  };
}

module.exports = {
  money,
  toTons,
  leg,
  getMaterialRates,
  calcTransaction,
  calcAggregate,
  calcRowsAggregate,
  enrichTransaction,
};
