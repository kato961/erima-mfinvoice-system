// ===================================================
// MF請求書連携 GAS WebApp
// Erima案件管理(Kintone App:180) → MoneyForward請求書API
// ===================================================
// GASプロジェクト: https://script.google.com/home/projects/1v5L7UfgIcqwNhImu6jkiZBnre7FQNB7v6jSIbhEEDr3PvquIEIlNl7bR/edit
// デプロイ設定: ウェブアプリ / 次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員

const MF_API_BASE = 'https://invoice.moneyforward.com/api/v3';
const KINTONE_DOMAIN = 'erima.cybozu.com';
const KINTONE_APP_ID = '180';

// MF請求書 APIトークン（PropertiesServiceで管理推奨）
const MF_API_TOKEN = 'YOUR_MF_API_TOKEN_HERE';

// Kintone APIトークン（PropertiesServiceで管理推奨）
const KINTONE_API_TOKEN = 'YOUR_KINTONE_API_TOKEN_HERE';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action || 'create_invoice';
    if (action === 'create_invoice') {
      return createInvoice(data);
    }
    return jsonResponse({success: false, error: 'Unknown action: ' + action});
  } catch (err) {
    console.error('doPost error:', err);
    return jsonResponse({success: false, error: err.toString()});
  }
}

function doGet(e) {
  return ContentService.createTextOutput('MF Invoice GAS WebApp is running.')
    .setMimeType(ContentService.MimeType.TEXT);
}

function createInvoice(data) {
  const recordId = data.record_id;
  const record = data.record;
  try {
    const partnerId = getOrCreatePartner(record);
    const invoice = createMfInvoice(partnerId, record);
    if (invoice && invoice.id) {
      updateKintoneRecord(recordId, invoice);
      return jsonResponse({
        success: true,
        invoice_id: invoice.id,
        invoice_url: invoice.pdf_url || '',
        share_url: invoice.shareable_url || ''
      });
    } else {
      return jsonResponse({success: false, error: '請求書の作成に失敗しました', detail: JSON.stringify(invoice)});
    }
  } catch (err) {
    console.error('createInvoice error:', err);
    return jsonResponse({success: false, error: err.toString()});
  }
}

function getOrCreatePartner(record) {
  const companyName = record['取引先'] || '';
  const searchUrl = MF_API_BASE + '/partners?keyword=' + encodeURIComponent(companyName) + '&per_page=5';
  const searchRes = callMfApi('GET', searchUrl);
  if (searchRes && searchRes.data && searchRes.data.length > 0) {
    const exact = searchRes.data.find(p => p.name === companyName);
    if (exact) return exact.id;
    return searchRes.data[0].id;
  }
  const newPartner = {
    name: companyName,
    name_kana: '',
    contact_name: record['氏名'] || '',
    zip: record['郵便番号'] || '',
    prefecture_code: getPrefectureCode(record['都道府県'] || ''),
    address1: record['住所1'] || '',
    address2: record['住所2'] || '',
    tel: record['電話番号'] || '',
    email: record['メールアドレス'] || ''
  };
  const createRes = callMfApi('POST', MF_API_BASE + '/partners', newPartner);
  if (createRes && createRes.id) return createRes.id;
  throw new Error('取引先の作成に失敗: ' + JSON.stringify(createRes));
}

function createMfInvoice(partnerId, record) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const dueDate = getNextMonthEnd();
  const items = buildInvoiceItems(record);
  const payload = {
    partner_id: partnerId,
    issue_date: today,
    due_date: dueDate,
    title: record['企画名'] || '請求書',
    memo: record['案件番号'] || '',
    items: items
  };
  return callMfApi('POST', MF_API_BASE + '/invoices', payload);
}

function buildInvoiceItems(record) {
  const items = [];
  const amount = parseFloat(record['売上合計（税別）'] || record['金額'] || 0);
  const name = record['企画名'] || record['作業区分'] || '作業費';
  if (amount > 0) {
    items.push({ name: name, quantity: 1, unit_price: amount, excise: 'ten_percent' });
  }
  if (items.length === 0) {
    items.push({ name: record['企画名'] || '作業費', quantity: 1, unit_price: 0, excise: 'ten_percent' });
  }
  return items;
}

function updateKintoneRecord(recordId, invoice) {
  const url = 'https://' + KINTONE_DOMAIN + '/k/v1/record.json';
  const payload = {
    app: parseInt(KINTONE_APP_ID),
    id: parseInt(recordId),
    record: {
      '請求書ID': { value: invoice.id || '' },
      '発行URL': { value: invoice.pdf_url || '' },
      '送付用URL（共有リンク）': { value: invoice.shareable_url || '' }
    }
  };
  const options = {
    method: 'PUT',
    contentType: 'application/json',
    headers: { 'X-Cybozu-API-Token': KINTONE_API_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  return JSON.parse(res.getContentText());
}

function callMfApi(method, url, payload) {
  const options = {
    method: method.toLowerCase(),
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + MF_API_TOKEN, 'Accept': 'application/json' },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch(url, options);
  const statusCode = res.getResponseCode();
  const text = res.getContentText();
  if (statusCode >= 200 && statusCode < 300) return JSON.parse(text);
  throw new Error('MF API Error ' + statusCode + ': ' + text);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getNextMonthEnd() {
  const d = new Date();
  const nextMonth = new Date(d.getFullYear(), d.getMonth() + 2, 0);
  return Utilities.formatDate(nextMonth, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function getPrefectureCode(prefectureName) {
  const map = {
    '北海道': 1, '青森県': 2, '岩手県': 3, '宮城県': 4, '秋田県': 5,
    '山形県': 6, '福島県': 7, '茨城県': 8, '栃木県': 9, '群馬県': 10,
    '埼玉県': 11, '千葉県': 12, '東京都': 13, '神奈川県': 14, '新潟県': 15,
    '富山県': 16, '石川県': 17, '福井県': 18, '山梨県': 19, '長野県': 20,
    '岐阜県': 21, '静岡県': 22, '愛知県': 23, '三重県': 24, '滋賀県': 25,
    '京都府': 26, '大阪府': 27, '兵庫県': 28, '奈良県': 29, '和歌山県': 30,
    '鳥取県': 31, '島根県': 32, '岡山県': 33, '広島県': 34, '山口県': 35,
    '徳島県': 36, '香川県': 37, '愛媛県': 38, '高知県': 39, '福岡県': 40,
    '佐賀県': 41, '長崎県': 42, '熊本県': 43, '大分県': 44, '宮崎県': 45,
    '鹿児島県': 46, '沖縄県': 47
  };
  return map[prefectureName] || null;
}
