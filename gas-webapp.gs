// ===================================================
// MF請求書連携 GAS WebApp (OAuth2版)
// Erima案件管理(Kintone App:180) → MoneyForward請求書API v3
// ===================================================
// GASプロジェクト: https://script.google.com/home/projects/1v5L7UfgIcqwNhImu6jkiZBnre7FQNB7v6jSIbhEEDr3PvquIEIlNl7bR/edit
// WebApp URL: https://script.google.com/macros/s/AKfycby1tZZp4KyvEvlS9gcAd4szlwcrWuxJvZAbt7d0BbJXZgZi1O7CDCKmICdv97uBKo8O/exec
// デプロイ設定: ウェブアプリ / 次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
//
// 【ライブラリ】
//   OAuth2: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMB4WLiH
//
// 【ScriptProperties (スクリプトプロパティ) に設定する値】
//   MF_CLIENT_ID     : MoneyForward OAuth2 クライアントID (1049780060218562)
//   MF_CLIENT_SECRET : MoneyForward OAuth2 クライアントシークレット
//   KINTONE_API_TOKEN: Kintone APIトークン (App:180)
//
// 【デプロイ履歴】
//   v8 (2026/11/25): OAuthエンドポイントをinvoice.moneyforward.comに変更、CLIENT_SECRET_BASIC対応

const MF_API_BASE    = 'https://invoice.moneyforward.com/api/v3';
const KINTONE_DOMAIN = 'erima.cybozu.com';
const KINTONE_APP_ID = '180';

function getKintoneApiToken() {
  return PropertiesService.getScriptProperties().getProperty('KINTONE_API_TOKEN');
}

// -------------------------------------------------------
// OAuth2 サービス設定
// -------------------------------------------------------
function getMfOAuthService() {
  const props = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('MF_CLIENT_ID');
  const clientSecret = props.getProperty('MF_CLIENT_SECRET');
  return OAuth2.createService('moneyforward')
    .setAuthorizationBaseUrl('https://invoice.moneyforward.com/oauth/authorize')
    .setTokenUrl('https://invoice.moneyforward.com/oauth/token')
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('invoice')
    .setParam('response_type', 'code')
    .setTokenHeaders({'Authorization': 'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret)});
}

function authCallback(request) {
  const service    = getMfOAuthService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('OK');
  } else {
    return HtmlService.createHtmlOutput('NG');
  }
}

function getAuthorizationUrl() {
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    const url = service.getAuthorizationUrl();
    console.log('認証URL: ' + url);
    return url;
  }
  return 'すでに認証済みです';
}

function resetAuth() {
  getMfOAuthService().reset();
  console.log('認証情報をリセットしました');
}

function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
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
  const params = e ? e.parameter : {};
  if (params.code || params.error) {
    return ContentService.createTextOutput('OAuth callback processed.')
      .setMimeType(ContentService.MimeType.TEXT);
  }
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    const authUrl = service.getAuthorizationUrl();
    return HtmlService.createHtmlOutput(
      '<h2>MoneyForward認証が必要です</h2>' +
      '<p><a href="' + authUrl + '" target="_blank">こちらをクリックして認証してください</a></p>'
    );
  }
  return ContentService.createTextOutput('MF Invoice GAS WebApp is running. 認証済み。')
    .setMimeType(ContentService.MimeType.TEXT);
}

function createInvoice(data) {
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    const authUrl = service.getAuthorizationUrl();
    return jsonResponse({
      success: false,
      auth_url: authUrl,
      error: 'MoneyForward認証が必要です'
    });
  }
  const recordId = data.record_id;
  const record   = data.record;
  try {
    const partnerId = getOrCreatePartner(record);
    const invoice   = createMfInvoice(partnerId, record);
    if (invoice && invoice.id) {
      updateKintoneRecord(recordId, invoice);
      return jsonResponse({
        success:     true,
        invoice_id:  invoice.id,
        invoice_url: invoice.pdf_url        || '',
        share_url:   invoice.shareable_url  || ''
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
  const searchUrl   = MF_API_BASE + '/partners?keyword=' + encodeURIComponent(companyName) + '&per_page=5';
  const searchRes   = callMfApi('GET', searchUrl);
  if (searchRes && searchRes.data && searchRes.data.length > 0) {
    const exact = searchRes.data.find(p => p.name === companyName);
    if (exact) return exact.id;
    return searchRes.data[0].id;
  }
  const newPartner = {
    name:            companyName,
    name_kana:       '',
    contact_name:    record['氏名']     || '',
    zip:             record['郵便番号'] || '',
    prefecture_code: getPrefectureCode(record['都道府県'] || ''),
    address1:        record['住所1']    || '',
    address2:        record['住所2']    || '',
    tel:             record['電話番号'] || '',
    email:           record['メールアドレス'] || ''
  };
  const createRes = callMfApi('POST', MF_API_BASE + '/partners', newPartner);
  if (createRes && createRes.id) return createRes.id;
  throw new Error('取引先の作成に失敗: ' + JSON.stringify(createRes));
}

function createMfInvoice(partnerId, record) {
  const today   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const dueDate = getNextMonthEnd();
  const items   = buildInvoiceItems(record);
  const payload = {
    partner_id: partnerId,
    issue_date: today,
    due_date:   dueDate,
    title:      record['企画名']  || '請求書',
    memo:       record['案件番号'] || '',
    items:      items
  };
  return callMfApi('POST', MF_API_BASE + '/invoices', payload);
}

function buildInvoiceItems(record) {
  const items  = [];
  const amount = parseFloat(record['売上合計（税別）'] || record['金額'] || 0);
  const name   = record['企画名'] || record['作業区分'] || '作業費';
  if (amount > 0) {
    items.push({name: name, quantity: 1, unit_price: amount, excise: 'ten_percent'});
  }
  if (items.length === 0) {
    items.push({name: record['企画名'] || '作業費', quantity: 1, unit_price: 0, excise: 'ten_percent'});
  }
  return items;
}

function updateKintoneRecord(recordId, invoice) {
  const url     = 'https://' + KINTONE_DOMAIN + '/k/v1/record.json';
  const payload = {
    app: parseInt(KINTONE_APP_ID),
    id:  parseInt(recordId),
    record: {
      mf_billing_url:       {value: invoice.pdf_url       || ''},
      mf_billing_share_url: {value: invoice.shareable_url || ''}
    }
  };
  const options = {
    method:          'PUT',
    contentType:     'application/json',
    headers:         {'X-Cybozu-API-Token': getKintoneApiToken()},
    payload:         JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  return JSON.parse(res.getContentText());
}

function callMfApi(method, url, payload) {
  const service     = getMfOAuthService();
  const accessToken = service.getAccessToken();
  const options = {
    method:      method.toLowerCase(),
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Accept':        'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);
  const res        = UrlFetchApp.fetch(url, options);
  const statusCode = res.getResponseCode();
  const text       = res.getContentText();
  if (statusCode >= 200 && statusCode < 300) return JSON.parse(text);
  throw new Error('MF API Error ' + statusCode + ': ' + text);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getNextMonthEnd() {
  const d         = new Date();
  const nextMonth = new Date(d.getFullYear(), d.getMonth() + 2, 0);
  return Utilities.formatDate(nextMonth, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function getPrefectureCode(prefectureName) {
  const map = {
    '北海道': 1,  '青森県': 2,  '岩手県': 3,  '宮城県': 4,  '秋田県': 5,
    '山形県': 6,  '福島県': 7,  '茨城県': 8,  '栃木県': 9,  '群馬県': 10,
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
