import { getCollection } from './mongo.js';

function formatRecord(doc) {
  return JSON.stringify(
    {
      advertiser_name: doc.advertiser_name || '',
      advertiser_domain: doc.advertiser_domain || '',
      brand: doc.brand || '',
      master_brand: doc.master_brand || '',
      channel_name: doc.channel_name || '',
      publisher_name: doc.publisher_name || '',
      publisher_domain: doc.publisher_domain || '',
      creative_campaign_name: doc.creative_campaign_name || '',
      creative_video_title: doc.creative_video_title || '',
      transaction_method: doc.transaction_method || '',
      ad_objective_type: doc.ad_objective_type || '',
      occurence_collectiondate: doc.occurence_collectiondate || '',
      occurence_user_device: doc.occurence_user_device || '',
      spend: doc.spend ?? null,
      impressions: doc.impressions ?? null,
      ctr: doc.ctr ?? null,
      cpm: doc.cpm ?? null,
    },
    null,
    2
  );
}

function formatCreative(doc) {
  const fields = {
    advertiser_name: doc.advertiser_name || '',
    creative_campaign_name: doc.creative_campaign_name || '',
    creative_video_title: doc.creative_video_title || '',
    creative_size: doc.creative_size || '',
    creative_mime_type: doc.creative_mime_type || '',
    creative_url_supplier: doc.creative_url_supplier || '',
    creative_landingpage_url: doc.creative_landingpage_url || '',
    creative_first_seen_date: doc.creative_first_seen_date || '',
    channel_name: doc.channel_name || '',
    publisher_name: doc.publisher_name || '',
    spend: doc.spend ?? null,
    impressions: doc.impressions ?? null,
    occurence_collectiondate: doc.occurence_collectiondate || '',
  };
  return JSON.stringify(fields, null, 2);
}

function buildAdvertiserQuery(companyName) {
  return { advertiser_name: companyName };
}

export async function searchCompany(companyName, limit = 5) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const docs = await coll
    .find(buildAdvertiserQuery(companyName), {
      collation: { locale: 'en', strength: 2 },
    })
    .sort({ occurence_collectiondate: -1 })
    .limit(limit)
    .toArray();

  if (docs.length === 0) {
    return `No records found for advertiser "${companyName}".`;
  }

  const formatted = docs.map(formatRecord).join('\n---\n');
  return `Found ${docs.length} most recent record(s) for "${companyName}":\n${formatted}`;
}

export async function countCompanyRecords(companyName) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const count = await coll.countDocuments(
    buildAdvertiserQuery(companyName),
    { collation: { locale: 'en', strength: 2 } }
  );
  return `Total records for advertiser "${companyName}": ${count}`;
}

export async function getCompanySpend(companyName, days = 30) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  const dateStr = dateFrom.toISOString().slice(0, 10);

  const query = {
    ...buildAdvertiserQuery(companyName),
    occurence_collectiondate: { $gte: dateStr },
  };

  const pipeline = [
    { $match: query },
    {
      $group: {
        _id: null,
        totalSpend: { $sum: '$spend' },
        totalImpressions: { $sum: '$impressions' },
        avgCtr: { $avg: '$ctr' },
        avgCpm: { $avg: '$cpm' },
        recordCount: { $sum: 1 },
      },
    },
  ];

  const result = await coll
    .aggregate(pipeline, { collation: { locale: 'en', strength: 2 } })
    .toArray();

  if (!result.length) {
    return `No spend data for "${companyName}" in the last ${days} days.`;
  }

  const r = result[0];
  return (
    `Spend summary for "${companyName}" (last ${days} days):\n` +
    `- Total spend: $${(r.totalSpend || 0).toFixed(2)}\n` +
    `- Total impressions: ${Math.round(r.totalImpressions || 0).toLocaleString()}\n` +
    `- Record count: ${r.recordCount}\n` +
    `- Average CTR: ${((r.avgCtr || 0) * 100).toFixed(3)}%\n` +
    `- Average CPM: $${(r.avgCpm || 0).toFixed(2)}`
  );
}

export async function getCompanyChannels(companyName) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const pipeline = [
    { $match: buildAdvertiserQuery(companyName) },
    {
      $group: {
        _id: '$channel_name',
        count: { $sum: 1 },
        totalSpend: { $sum: '$spend' },
      },
    },
    { $sort: { count: -1 } },
  ];

  const results = await coll
    .aggregate(pipeline, { collation: { locale: 'en', strength: 2 } })
    .toArray();

  if (!results.length) {
    return `No channel data for "${companyName}".`;
  }

  const lines = results
    .map(
      (r) =>
        `- ${r._id || 'Unknown'}: ${r.count} records, total spend $${(r.totalSpend || 0).toFixed(2)}`
    )
    .join('\n');

  return `Channel breakdown for "${companyName}":\n${lines}`;
}

export async function getSpendTrend(companyName, days = 30) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  const dateStr = dateFrom.toISOString().slice(0, 10);

  const query = {
    ...buildAdvertiserQuery(companyName),
    occurence_collectiondate: { $gte: dateStr },
  };

  const pipeline = [
    { $match: query },
    {
      $group: {
        _id: '$occurence_collectiondate',
        totalSpend: { $sum: '$spend' },
        totalImpressions: { $sum: '$impressions' },
        recordCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const results = await coll
    .aggregate(pipeline, { collation: { locale: 'en', strength: 2 } })
    .toArray();

  if (!results.length) {
    return `No spend trend data for "${companyName}" in the last ${days} days.`;
  }

  const lines = results
    .map(
      (r) =>
        `- ${r._id}: spend $${(r.totalSpend || 0).toFixed(2)}, impressions ${Math.round(
          r.totalImpressions || 0
        ).toLocaleString()}, records ${r.recordCount}`
    )
    .join('\n');

  return `Daily spend trend for "${companyName}" (last ${days} days):\n${lines}`;
}

export async function compareCompanies(companyNames, days = 30) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  const dateStr = dateFrom.toISOString().slice(0, 10);

  const names = Array.isArray(companyNames)
    ? companyNames
    : companyNames.split(',').map((n) => n.trim());

  const pipeline = [
    {
      $match: {
        advertiser_name: { $in: names },
        occurence_collectiondate: { $gte: dateStr },
      },
    },
    {
      $group: {
        _id: '$advertiser_name',
        totalSpend: { $sum: '$spend' },
        totalImpressions: { $sum: '$impressions' },
        avgCtr: { $avg: '$ctr' },
        avgCpm: { $avg: '$cpm' },
        recordCount: { $sum: 1 },
      },
    },
    { $sort: { totalSpend: -1 } },
  ];

  const results = await coll
    .aggregate(pipeline, { collation: { locale: 'en', strength: 2 } })
    .toArray();

  if (!results.length) {
    return `No data for the requested companies in the last ${days} days.`;
  }

  const lines = results
    .map(
      (r, i) =>
        `${i + 1}. ${r._id}: spend $${(r.totalSpend || 0).toFixed(2)}, impressions ${Math.round(
          r.totalImpressions || 0
        ).toLocaleString()}, CTR ${((r.avgCtr || 0) * 100).toFixed(3)}%, CPM $${(
          r.avgCpm || 0
        ).toFixed(2)}, records ${r.recordCount}`
    )
    .join('\n');

  return `Comparison (last ${days} days):\n${lines}`;
}

export async function getCreatives(companyName, limit = 5) {
  const coll = getCollection();
  if (!coll) throw new Error('MongoDB not connected');

  const docs = await coll
    .find(buildAdvertiserQuery(companyName), {
      collation: { locale: 'en', strength: 2 },
    })
    .sort({ creative_first_seen_date: -1 })
    .limit(limit)
    .toArray();

  if (docs.length === 0) {
    return `No creative records found for advertiser "${companyName}".`;
  }

  const formatted = docs.map(formatCreative).join('\n---\n');
  return `Found ${docs.length} most recent creative(s) for "${companyName}":\n${formatted}`;
}
