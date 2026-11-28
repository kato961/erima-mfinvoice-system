// ===================================================
// MF請求書連携 GAS WebApp (OAuth2版) v12
// Erima案件管理(Kintone App:180) → MoneyForward請求書API v3
// ===================================================
// GASプロジェクト: https://script.google.com/home/projects/1v5L7UfgIcqwNhImu6jkiZBnre7FQNB7v6jSIbhEEDr3PvquIEIlNl7bR/edit
// デプロイ設定: ウェブアプリ / 次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
//
// 【ライブラリ】
//   OAuth2: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMB4WLiH
//
// 【ScriptProperties (スクリプトプロパティ) に設定する値】
//   MF_CLIENT_ID         : MoneyForward OAuth2 クライアントID
//   MF_CLIENT_SECRET     : MoneyForward OAuth2 クライアントシークレット
//   KINTONE_API_TOKEN    : Kintone APIトークン (App:180 案件管理)
//   MF_TOKEN_AUTH_METHOD : (任意) 'post' にするとBasicヘッダーを使わずbodyで認証
//
// 【v11での変更点 (2026/11/28)】
//   - OAuth2エンドポイントを公式仕様に修正:
//       認可:   https://api.biz.moneyforward.com/authorize
//       トークン: https://api.biz.moneyforward.com/token
//   - scope を 'mfc/invoice/data.write' に修正（旧 'invoice' はv3では無効）
//   - トークン保存先を ScriptProperties に変更（認証が安定して持続する）
//   - 請求書作成を v3 の正式エンドポイント POST /invoice_template_billings に変更
//     （department_id 必須。partner_id では作成できない）
//   - 取引先解決ロジックを刷新:
//       顧客マスタ(App:178)の mf_partner_id / mf_department_id を最優先
//       → 無ければMF側を名前で正規化突合（「検索1件目を使う」は廃止）
//       → それでも無ければMFに取引先＋部門を新規作成し、IDを返す
//   - 支払期日: 顧客マスタの支払月・支払日から due_date を計算（無ければ翌月末）
//   - action: 'ping' / 'list_partners' / 'resolve_partner' を追加
// ===================================================

const MF_API_BASE    = 'https://invoice.moneyforward.com/api/v3';
const MF_AUTH_URL    = 'https://api.biz.moneyforward.com/authorize';
const MF_TOKEN_URL   = 'https://api.biz.moneyforward.com/token';
const MF_SCOPE       = 'mfc/invoice/data.write';
const KINTONE_DOMAIN = 'erima.cybozu.com';
const KINTONE_APP_ID = '180';

function getKintoneApiToken() {
  return PropertiesService.getScriptProperties().getProperty('KINTONE_API_TOKEN');
}

// -------------------------------------------------------
// OAuth2 サービス設定
// -------------------------------------------------------
function getMfOAuthService() {
  const props        = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('MF_CLIENT_ID');
  const clientSecret = props.getProperty('MF_CLIENT_SECRET');
  const service = OAuth2.createService('moneyforward_v3')
    .setAuthorizationBaseUrl(MF_AUTH_URL)
    .setTokenUrl(MF_TOKEN_URL)
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setScope(MF_SCOPE)
    .setParam('response_type', 'code');
  if (props.getProperty('MF_TOKEN_AUTH_METHOD') !== 'post') {
    service.setTokenHeaders({
      'Authorization': 'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret)
    });
  }
  return service;
}

function authCallback(request) {
  const service    = getMfOAuthService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('<h2>認証OK</h2><p>このタブは閉じて構いません。Kintoneに戻って請求書発行をお試しください。</p>');
  } else {
    return HtmlService.createHtmlOutput('<h2>認証NG</h2><p>認証に失敗しました。もう一度お試しください。</p>');
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

// -------------------------------------------------------
// WebApp エントリポイント
// -------------------------------------------------------
function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action || 'create_invoice';
    if (action === 'ping')            return jsonResponse({success: true, pong: true, version: 'v11'});
    if (action === 'create_invoice')  return createInvoice(data);
    if (action === 'resolve_partner') return resolvePartnerAction(data);
    if (action === 'list_partners')   return listPartnersAction(data);
    if (action === 'mfCreateBillingFromProject') return createFromProjectAction(data.billing && data.billing.projectRecordId);
    if (action === 'mfConvertToBilling')          return createFromProjectAction(data.projectRecordId);
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
  return ContentService.createTextOutput('MF Invoice GAS WebApp v11 is running. 認証済み。')
    .setMimeType(ContentService.MimeType.TEXT);
}

// -------------------------------------------------------
// 請求書作成
// data.customer: kintone顧客マスタ(App:178)の情報（kintone JSが送ってくる）
//   { record_no, code, name, name_kana, zip, tel, address, payment_month, payment_day,
//     mf_partner_id, mf_department_id }
// data.record:   案件管理の請求情報 { 案件番号, 企画名, 作業区分, 売上合計（税別） }
// -------------------------------------------------------
function createInvoice(data) {
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    return jsonResponse({
      success: false,
      auth_url: service.getAuthorizationUrl(),
      error: 'MoneyForward認証が必要です（エラー横のリンクから再認証してください）'
    });
  }
  const recordId = data.record_id;
  const record   = data.record || {};
  const customer = data.customer || {};
  try {
    const resolved = resolveMfPartner(customer, record);
    const invoice  = createMfBilling(resolved.department_id, record, customer);
    if (invoice && invoice.id) {
      updateKintoneRecord(recordId, invoice);
      return jsonResponse({
        success:            true,
        invoice_id:         invoice.id,
        invoice_url:        invoice.pdf_url || '',
        partner_id:         resolved.partner_id,
        department_id:      resolved.department_id,
        partner_created:    resolved.created,
        partner_resolved_by: resolved.resolved_by
      });
    }
    return jsonResponse({success: false, error: '請求書の作成に失敗しました', detail: JSON.stringify(invoice)});
  } catch (err) {
    console.error('createInvoice error:', err);
    return jsonResponse({success: false, error: err.toString()});
  }
}

// -------------------------------------------------------
// MF取引先の解決
// 優先順位: 顧客マスタ保存済みID → MF側を名前で正規化突合 → 新規作成
// -------------------------------------------------------
function resolveMfPartner(customer, record) {
  // 1. 顧客マスタに保存済みのIDがあればそれを使う
  if (customer.mf_partner_id && customer.mf_department_id) {
    return {
      partner_id:    customer.mf_partner_id,
      department_id: customer.mf_department_id,
      created:       false,
      resolved_by:   'kintone_master'
    };
  }
  const name = (customer.name || record['取引先'] || '').trim();
  if (!name) throw new Error('取引先名が空のため発行できません。案件の「☆取引先」と顧客マスタをご確認ください。');

  // 2. MF側を名前で検索し、正規化して完全一致のみ採用（曖昧一致は使わない）
  const target = normalizeName(name);
  let found = null;
  const byName = callMfApi('GET', MF_API_BASE + '/partners?per_page=100&name=' + encodeURIComponent(name));
  if (byName && byName.data) {
    found = byName.data.find(function(p) { return normalizeName(p.name) === target; }) || null;
  }
  if (!found) {
    // 名前フィルタで見つからない場合、全件走査（最大30ページ=3000件）で正規化突合
    for (let page = 1; page <= 30; page++) {
      const res = callMfApi('GET', MF_API_BASE + '/partners?per_page=100&page=' + page);
      if (!res || !res.data || res.data.length === 0) break;
      found = res.data.find(function(p) { return normalizeName(p.name) === target; }) || null;
      if (found) break;
      if (res.pagination && page >= res.pagination.total_pages) break;
    }
  }
  if (found) {
    let deptId = (found.departments && found.departments.length > 0) ? found.departments[0].id : null;
    if (!deptId) {
      const dept = callMfApi('POST', MF_API_BASE + '/partners/' + found.id + '/departments', buildDepartmentPayload(customer));
      deptId = dept.id;
    }
    return {partner_id: found.id, department_id: deptId, created: false, resolved_by: 'mf_name_match'};
  }

  // 3. 新規作成（顧客マスタの情報から）
  const payload = {
    name:        name,
    name_suffix: '御中',
    departments: [buildDepartmentPayload(customer)]
  };
  if (customer.name_kana) payload.name_kana = customer.name_kana;
  if (customer.code)      payload.code      = String(customer.code).slice(0, 30);
  else if (customer.record_no) payload.code = 'ERM-' + customer.record_no;
  const pds = buildPaymentDeadlineSetting(customer);
  if (pds) payload.payment_deadline_setting = pds;

  const created = callMfApi('POST', MF_API_BASE + '/partners', payload);
  if (!created || !created.id) throw new Error('取引先の作成に失敗: ' + JSON.stringify(created));
  const deptId = (created.departments && created.departments.length > 0) ? created.departments[0].id : null;
  if (!deptId) throw new Error('取引先は作成されましたが部門IDが取得できませんでした: ' + created.id);
  return {partner_id: created.id, department_id: deptId, created: true, resolved_by: 'mf_created'};
}

// 部門payload（最低1項目必須。バリデーションに通る項目だけ入れる）
function buildDepartmentPayload(customer) {
  const dept = {};
  const zip = String(customer.zip || '').replace(/[^0-9\-]/g, '');
  if (/^\d{3}-?\d{4}$/.test(zip)) dept.zip = zip;
  const tel = String(customer.tel || '').trim();
  if (/^(\+)?[0-9０-９\-－ー−]{7,30}$/.test(tel)) dept.tel = tel;
  // 住所：都道府県 / 住所1 / 住所2
  if (customer.prefecture && customer.prefecture !== 'その他') {
    dept.prefecture = String(customer.prefecture).slice(0, 20);
  }
  if (customer.address1) {
    let a1 = String(customer.address1).trim();
    const pref = extractPrefecture(a1);
    if (pref) {
      if (!dept.prefecture) dept.prefecture = pref;
      a1 = a1.slice(pref.length).trim(); // 住所1の先頭にある都道府県は除く
    }
    dept.address1 = a1.slice(0, 80);
  } else if (customer.address) {
    let a = String(customer.address).trim();
    const pref = extractPrefecture(a);
    if (pref) {
      if (!dept.prefecture) dept.prefecture = pref;
      a = a.slice(pref.length).trim();
    }
    dept.address1 = a.slice(0, 80);
  }
  if (customer.address2) dept.address2 = String(customer.address2).slice(0, 80);
  // 担当者
  if (customer.person_name)  dept.person_name  = String(customer.person_name).slice(0, 35);
  if (customer.person_title) dept.person_title = String(customer.person_title).slice(0, 35);
  if (customer.person_dept)  dept.person_dept  = String(customer.person_dept).slice(0, 35);
  // メール（TO / CC）
  const email = String(customer.email || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) dept.email = email.slice(0, 250);
  const cc = String(customer.cc_emails || '').trim();
  if (cc) dept.cc_emails = cc.slice(0, 250);
  if (Object.keys(dept).length === 0) dept.person_name = 'ご担当者';
  return dept;
}

// 顧客マスタの支払月・支払日 → MFのpayment_deadline_setting
function buildPaymentDeadlineSetting(customer) {
  const monthMap = {'翌月': 'next_month', '翌々月': 'two_months_after', '翌翌々月': 'three_months_after'};
  const dueMonth = monthMap[customer.payment_month];
  if (!dueMonth) return null;
  let dueDate = -1;
  const m = String(customer.payment_day || '').match(/^(\d{1,2})日$/);
  if (m) dueDate = parseInt(m[1], 10);
  else if (customer.payment_day !== '末日') dueDate = -1;
  return {due_month: dueMonth, due_date: dueDate, contingency_day: 'move_to_earlier_day'};
}

// -------------------------------------------------------
// 請求書作成 (POST /invoice_template_billings)
// -------------------------------------------------------
function createMfBilling(departmentId, record, customer) {
  const today   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const dueDate = computeDueDate(customer);
  const items   = buildInvoiceItems(record);
  const payload = {
    department_id: departmentId,
    billing_date:  today,
    due_date:      dueDate,
    title:         (record['企画名'] || '請求書').slice(0, 200),
    memo:          (record['案件番号'] || '').slice(0, 450),
    items:         items
  };
  return callMfApi('POST', MF_API_BASE + '/invoice_template_billings', payload);
}

function buildInvoiceItems(record) {
  // 案件明細（サブテーブル）から展開した明細行があればそれを使う
  if (record['明細行'] && record['明細行'].length) return record['明細行'];
  // フォールバック：売上合計を1行で計上
  const raw    = String(record['売上合計（税別）'] || record['金額'] || '0').replace(/[,，]/g, '');
  const amount = parseFloat(raw) || 0;
  const name   = (record['企画名'] || record['作業区分'] || '作業費').slice(0, 450);
  return [{name: name, quantity: 1, price: amount, excise: 'ten_percent'}];
}

// 案件明細(サブテーブル)の各行 → MF請求書の明細行配列
function buildLineItemsFromSubtable(rec) {
  const lines = [];
  const sub = rec['案件明細'] && rec['案件明細'].value;
  if (!sub || !sub.length) return lines;
  sub.forEach(function (rowObj) {
    const row = rowObj.value || {};
    const rg  = function (c) { return (row[c] && row[c].value != null) ? String(row[c].value) : ''; };
    const num = function (c) { return parseFloat(rg(c).replace(/[,，]/g, '')) || 0; };
    const qty    = num('数量');
    const uprice = num('単価');
    const amount = num('金額');
    if (qty <= 0 && uprice <= 0 && amount <= 0) return; // 空行はスキップ
    const name   = (rg('メール表示名') || rg('企画名') || (rg('作業区分') + ' ' + rg('仕様_1')).trim() || '作業費').slice(0, 450);
    const excise = /8\s*%|軽減/.test(rg('消費税')) ? 'eight_percent' : 'ten_percent';
    const detail = rg('帳票用備考').slice(0, 450);
    let item;
    if (qty > 0 && uprice > 0) {
      item = {name: name, quantity: qty, unit: rg('単位') || '', price: uprice, excise: excise};
    } else {
      // 数量・単価が揃わない行は金額を単価・数量1で計上
      item = {name: name, quantity: 1, price: amount, excise: excise};
    }
    if (detail) item.detail = detail;
    lines.push(item);
  });
  return lines;
}

// 支払月・支払日からdue_dateを計算。情報が無ければ翌月末。
function computeDueDate(customer) {
  const monthAdd = {'翌月': 1, '翌々月': 2, '翌翌々月': 3}[customer.payment_month] || 1;
  const now = new Date();
  let d;
  const m = String(customer.payment_day || '').match(/^(\d{1,2})日$/);
  if (m) {
    const day     = parseInt(m[1], 10);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + monthAdd + 1, 0).getDate();
    d = new Date(now.getFullYear(), now.getMonth() + monthAdd, Math.min(day, lastDay));
  } else {
    d = new Date(now.getFullYear(), now.getMonth() + monthAdd + 1, 0); // 末日
  }
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

// -------------------------------------------------------
// 取引先解決のみ行うaction（顧客マスタ一括同期用）
// -------------------------------------------------------
function resolvePartnerAction(data) {
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    return jsonResponse({success: false, auth_url: service.getAuthorizationUrl(), error: 'MoneyForward認証が必要です'});
  }
  try {
    const allowCreate = data.allow_create === true;
    const customer    = data.customer || {};
    if (!allowCreate) {
      // 突合のみ（作成しない）
      const name   = (customer.name || '').trim();
      if (!name) return jsonResponse({success: false, error: '顧客名が空です'});
      const target = normalizeName(name);
      const byName = callMfApi('GET', MF_API_BASE + '/partners?per_page=100&name=' + encodeURIComponent(name));
      const found  = (byName && byName.data) ? (byName.data.find(function(p){ return normalizeName(p.name) === target; }) || null) : null;
      if (!found) return jsonResponse({success: true, matched: false});
      return jsonResponse({
        success: true, matched: true,
        partner_id: found.id,
        department_id: (found.departments && found.departments[0]) ? found.departments[0].id : null
      });
    }
    const resolved = resolveMfPartner(customer, {});
    return jsonResponse({success: true, matched: true, partner_id: resolved.partner_id, department_id: resolved.department_id, created: resolved.created});
  } catch (err) {
    return jsonResponse({success: false, error: err.toString()});
  }
}

// MF取引先一覧のページ取得（顧客マスタ一括同期用）
function listPartnersAction(data) {
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    return jsonResponse({success: false, auth_url: service.getAuthorizationUrl(), error: 'MoneyForward認証が必要です'});
  }
  try {
    const page = parseInt(data.page, 10) || 1;
    const res  = callMfApi('GET', MF_API_BASE + '/partners?per_page=100&page=' + page);
    const slim = (res.data || []).map(function(p) {
      return {
        id: p.id, code: p.code || '', name: p.name, name_kana: p.name_kana || '',
        department_ids: (p.departments || []).map(function(d) { return d.id; })
      };
    });
    return jsonResponse({success: true, page: page, pagination: res.pagination, partners: slim});
  } catch (err) {
    return jsonResponse({success: false, error: err.toString()});
  }
}

// -------------------------------------------------------
// 名前の正規化（表記ゆれ吸収: 全半角・スペース・(株)など）
// -------------------------------------------------------
function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/\(株\)/g, '株式会社')
    .replace(/\(有\)/g, '有限会社')
    .replace(/\(同\)/g, '合同会社');
}

function extractPrefecture(address) {
  const prefs = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
  for (let i = 0; i < prefs.length; i++) {
    if (address.indexOf(prefs[i]) === 0) return prefs[i];
  }
  return null;
}

// -------------------------------------------------------
// Kintoneレコード更新（発行結果の書き戻し）
// -------------------------------------------------------
function updateKintoneRecord(recordId, invoice) {
  const url     = 'https://' + KINTONE_DOMAIN + '/k/v1/record.json';
  const payload = {
    app: parseInt(KINTONE_APP_ID),
    id:  parseInt(recordId),
    record: {
      mf_billing_id:  {value: invoice.id || ''},
      mf_billing_url: {value: invoice.pdf_url || ''}
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

// -------------------------------------------------------
// MF API 呼び出し共通
// -------------------------------------------------------
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

// -------------------------------------------------------
// パネルボタン(erima-180-invoice.js)用: 案件レコードから請求書発行
// 応答は {ok, url, billingId, shareUrl, message} 形式で返す
// -------------------------------------------------------
function createFromProjectAction(projectRecordId) {
  const service = getMfOAuthService();
  if (!service.hasAccess()) {
    return jsonResponse({ok: false, auth_url: service.getAuthorizationUrl(), message: 'MoneyForward認証が必要です。管理者で再認証してください。'});
  }
  try {
    if (!projectRecordId) return jsonResponse({ok: false, message: '案件レコードIDが取得できませんでした'});
    const rec = fetchKintoneRecord(KINTONE_APP_ID, projectRecordId);
    const g = function (c) { return (rec[c] && rec[c].value != null) ? String(rec[c].value) : ''; };
    const record = {
      '取引先':          g('name_partner'),
      '案件番号':        g('project_number'),
      '企画名':          g('project_name'),
      '作業区分':        g('作業区分'),
      '売上合計（税別）': g('売上合計_税別') || '0'
    };
    // 担当者・連絡先は案件(180)の「担当者（部門）」セクションから取得
    const ccList = ['メールアドレス_0','メールアドレス_1','メールアドレス_2','メールアドレス_3','メールアドレス_4','メールアドレス_5']
      .map(function (k) { return g(k); }).filter(function (x) { return x; });
    let customer = {
      name:         g('name_partner'),
      zip:          g('zip'),
      tel:          g('電話番号') || g('携帯番号'),
      person_name:  g('person_name'),
      person_title: g('person_title'),
      person_dept:  g('department_name'),
      email:        g('担当者メールアドレス'),
      cc_emails:    ccList.join(',')
    };
    const custCode = g('顧客コード');
    try {
      if (custCode) {
        const cms = fetchKintoneRecordsByQuery(178, 'レコード番号 = "' + custCode + '" limit 1');
        if (cms && cms.length) {
          const c = cms[0];
          const cg = function (code) { return (c[code] && c[code].value != null) ? String(c[code].value) : ''; };
          if (cg('name')) customer.name = cg('name');
          customer.name_kana        = cg('name_kana');
          customer.zip              = cg('郵便番号') || customer.zip;
          customer.tel              = cg('代表番号') || customer.tel;
          // 住所は顧客マスタ(178)が正。住所1=住所 / 住所2=建物・号室
          customer.address1         = cg('住所') || customer.address1;
          customer.address2         = cg('建物・号室') || customer.address2;
          customer.payment_month    = cg('支払月');
          customer.payment_day      = cg('支払日');
          customer.mf_partner_id    = cg('mf_partner_id');
          customer.mf_department_id = cg('mf_department_id');
          customer.record_no        = cg('レコード番号');
        }
      }
    } catch (e) { /* 顧客マスタ(178)が読めない場合は名前突合にフォールバック */ }
    // 案件明細(サブテーブル)を請求書の明細行に展開
    record['明細行'] = buildLineItemsFromSubtable(rec);
    const resolved = resolveMfPartner(customer, record);
    const invoice  = createMfBilling(resolved.department_id, record, customer);
    if (invoice && invoice.id) {
      updateKintoneRecord(projectRecordId, invoice);
      if (customer.record_no && (customer.mf_partner_id !== resolved.partner_id || customer.mf_department_id !== resolved.department_id)) {
        try { writeBackCustomerMf(customer.record_no, resolved.partner_id, resolved.department_id); } catch (e) {}
      }
      return jsonResponse({ok: true, url: invoice.pdf_url || '', billingId: invoice.id, shareUrl: ''});
    }
    return jsonResponse({ok: false, message: '請求書の作成に失敗しました'});
  } catch (err) {
    console.error('createFromProjectAction error:', err);
    return jsonResponse({ok: false, message: err.toString()});
  }
}

function fetchKintoneRecord(app, id) {
  const url = 'https://' + KINTONE_DOMAIN + '/k/v1/record.json?app=' + app + '&id=' + id;
  const res = UrlFetchApp.fetch(url, {method: 'get', headers: {'X-Cybozu-API-Token': getKintoneApiToken()}, muteHttpExceptions: true});
  const j = JSON.parse(res.getContentText());
  if (!j.record) throw new Error('案件レコード取得に失敗しました: ' + res.getContentText());
  return j.record;
}

function fetchKintoneRecordsByQuery(app, query) {
  const url = 'https://' + KINTONE_DOMAIN + '/k/v1/records.json?app=' + app + '&query=' + encodeURIComponent(query);
  const res = UrlFetchApp.fetch(url, {method: 'get', headers: {'X-Cybozu-API-Token': getKintoneApiToken()}, muteHttpExceptions: true});
  const j = JSON.parse(res.getContentText());
  if (!j.records) throw new Error('records read failed');
  return j.records;
}

function writeBackCustomerMf(recNo, pid, did) {
  const url = 'https://' + KINTONE_DOMAIN + '/k/v1/record.json';
  const payload = {app: 178, id: parseInt(recNo), record: {mf_partner_id: {value: pid}, mf_department_id: {value: did}}};
  const res = UrlFetchApp.fetch(url, {method: 'put', contentType: 'application/json', headers: {'X-Cybozu-API-Token': getKintoneApiToken()}, payload: JSON.stringify(payload), muteHttpExceptions: true});
  return JSON.parse(res.getContentText());
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
