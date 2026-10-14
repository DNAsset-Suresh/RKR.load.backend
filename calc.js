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

/**
 * Full calculation for a single load.
 */
function calcTransaction(weightKg, settings) {
  const kg = new Decimal(weightKg || 0);
  const tons = toTons(kg);

  const customer = leg(tons, settings.customerRatePerTon || 930, settings.customerGstRate || 5);
  const company = leg(tons, settings.companyRatePerTon || 920, settings.companyGstRate || 5);

  const rkrProfitRate = new Decimal(settings.rkrProfitPerTon || 10);
  const rkrProfit = money(tons.mul(rkrProfitRate));

  return {
    weightKg: kg.toNumber(),
    weightTons: tons.toNumber(),

    customerRatePerTon: Number(settings.customerRatePerTon || 930),
    customerGstRate: Number(settings.customerGstRate || 5),
    customerBaseAmount: customer.base.toNumber(),
    customerGstAmount: customer.gst.toNumber(),
    customerTotalAmount: customer.total.toNumber(),

    companyRatePerTon: Number(settings.companyRatePerTon || 920),
    companyGstRate: Number(settings.companyGstRate || 5),
    companyBaseAmount: company.base.toNumber(),
    companyGstAmount: company.gst.toNumber(),
    companyTotalAmount: company.total.toNumber(),

    rkrProfitPerTon: rkrProfitRate.toNumber(),
    rkrProfit: rkrProfit.toNumber(),
  };
}

/**
 * Period totals recomputed from summed KG.
 */
function calcAggregate(totalWeightKg, loadCount, settings) {
  const r = calcTransaction(totalWeightKg, settings);
  return {
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
  const calc = calcTransaction(t.weightKg, {
    ...settings,
    rkrProfitPerTon: t.rkrProfitPerTon || settings.rkrProfitPerTon
  });

  return {
    ...t,
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
  calcTransaction,
  calcAggregate,
  enrichTransaction,
};
