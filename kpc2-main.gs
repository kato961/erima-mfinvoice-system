// KPC2 エリア表作成AIエージェントシステム 本体 GAS
// ROLE: main
// jimukyoku@erima.co で新規プロジェクトを作成してこのコードを貼り付ける
// ===== 設定 =====

const CONFIG = {
  KINTONE_DOMAIN: 'erima.cybozu.com',
  APP: {
    CUSTOMER: 178, // ☆顧客・担当マスタ
    PROJECT: 180,  // ☆案件管理
    QUOTE: 182,    // ☆見積管理（元 ☆営業管理（見積書））
    TODO: 212,     // ToDo受信メール（KPC2ハブ）
    AREA: 75,      // エリア表作成指示（旧方式・後方互換のため残す）
  },
  CLAUDE_MODEL: 'claude-haiku-5-5',
  CLAUDE_EFFORT: 'low',
  CLAUDE_MAX_TOKENS: 8000,
  GMAIL_QUERY: 'in:inbox newer_than:2d -category:promotions -category:social',
  MAX_MAILS_PER_RUN: 5,
  MAX_BODY_CHARS: 40000,
  MAX_ATTACH_BYTES: 20 * 1024 * 1024,
  LABEL_DONE: 'AI処理済',
  SKIP_FROM: [
    'mailer-daemon', 'noreply', 'no-reply', 'do-not-reply', 'notification',
    '@chatwork.com', '@moneyforward.com', '@cybozu.com', '@kintoneapp.com',
    '@dropbox.com', '@google.com', '@accounts.google.com',
  ],
  URL_EXPIRE_DAYS: 7,
  STAFF: [
    { name: '加藤', code: 'kato@erima.co' },
    { name: '森',   code: 'mori@erima.co' },
    { name: '亀井', code: 'kamei' },
    { name: '坪佐', code: 'tsubosa@gmail.com' },
  ],
  FIELD: {
    CUSTOMER: {
      key: '$id',
      company: 'name',
      repTel: '代表番号',
      zip: '郵便番号',
      address: '住所',
      paymentType: '支払方法',
      payMonth: '支払月',
      payDay: '支払日',
      closingDay: '',
      source: '',
      person: {
        table: 'department',
        prefecture: 'prefecture',
        department: 'department_name',
        position: 'person_title',
        name: 'person_name',
        zip: 'zip',
        address1: 'address1',
        tel: 'tel',
        email: 'email',
      },
    },
    PROJECT: {
      customerLookup: '顧客コード',
      projectNumber: 'project_number',
      projectName: 'project_name',
      partnerName: 'name_partner',
      personName: 'person_name',
      staff: 'user_name',
      endDate: 'project_end_date',
      orderDate: '注文日',
      note: '内容_0',
      source: '',
      gmailId: '',
      items: {
        table: '案件明細',
        name: '企画名',
        detail: '品目詳細',
        qty: '数量',
        unit: '単位',
        unitPrice: '単価',
        doneDate: '完了日',
        tax: '消費税',
        taxValue: '10%',
      },
      emptyTables: ['quotation_list', 'invoice_list'],
    },
    QUOTE: {
      customerLookup: 'partner_id',
      partnerName: 'name_partner',
      personName: 'person_name',
      email: 'メールアドレス',
      subject: 'title',
      projectName: 'project_name',
      planName: '',
      quoteDate: 'quote_date',
      expiredDate: 'expired_date',
      deliveryDate: '',
      note: 'note',
      status: '状況',
      statusValue: '進捗中',
      staff: '案件担当者名',
      items: { table: 'items', name: 'items_name', detail: 'detail', qty: 'quantity', unit: 'unit', unitPrice: 'unit_price', tax: 'excise', taxValue: '10%' },
    },
    TODO: {
      // App 212 (ToDo受信メール) のフィールド定義
      subject: 'subject',
      from: 'from',
      to: 'to',
      date: 'date',
      body: 'body',
      gmailId: 'gmail_id',
      rfcId: 'rfc_id',
      mailbox: 'mailbox',
      status: 'status',      // 未対応 / 対応中 / 完了 / スキップ
      category: 'category',  // AIが判断したカテゴリ
      summary: 'summary',    // AI要約
      action: 'action',      // AIの推奨アクション
      areaStatus:   'area_status',   // エリア表: 作成待ち / 作業中 / 完了 / 失敗 / 要確認
      areaQuestion: 'area_question', // 要確認の質問 / 完了時の説明
      areaAnswer:   'area_answer',   // 加藤さんの回答
      areaRecordId: 'area_record_id',// （旧方式互換）
    },
  },
  PROJECT_DEFAULTS: {
    '状態': { value: '受注' },
  },
  // エリア表を自動実行するカテゴリ（TODO_AUTO_AREA_CATEGORIESスクリプトプロパティで上書き可能）
  AUTO_AREA_CATEGORIES: ['エリア表作成'],
};

// ===== ユーティリティ =====

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('スクリプトプロパティが未設定です：' + key);
  return v;
}

function propOrEmpty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// ===== 初期設定 =====

function setupMain() {
  const props = PropertiesService.getScriptProperties();

  // シークレットを自動生成
  if (!props.getProperty('URL_SECRET')) {
    props.setProperty('URL_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  if (!props.getProperty('KINTONE_SHARED_SECRET')) {
    props.setProperty('KINTONE_SHARED_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  if (!props.getProperty('SUB_SHARED_SECRET')) {
    props.setProperty('SUB_SHARED_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }

  // スプレッドシートを作成（キュー用）
  if (!props.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('KPC2メールキュー');
    const sheet = ss.getActiveSheet();
    sheet.setName('queue');
    sheet.appendRow(['id', 'payload', 'created_at', 'status']);
    props.setProperty('SHEET_ID', ss.getId());
    console.log('スプレッドシート作成：', ss.getUrl());
  }

  // START_ATを今の時刻に設定
  props.setProperty('START_AT', String(Date.now()));

  console.log('setupMain 完了');
  console.log('URL_SECRET:', props.getProperty('URL_SECRET'));
  console.log('KINTONE_SHARED_SECRET:', props.getProperty('KINTONE_SHARED_SECRET'));
  console.log('SUB_SHARED_SECRET:', props.getProperty('SUB_SHARED_SECRET'));
  console.log('SHEET_ID:', props.getProperty('SHEET_ID'));
  console.log('※ デプロイ後 WEBAPP_URL をスクリプトプロパティに設定してください');
}

// ===== Webアプリ エントリポイント =====

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'KPC2 main is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body    = JSON.parse(e.postData.contents || '{}');
    const action  = body.action  || '';
    const secret  = body.secret  || '';
    const payload = body.payload || {};

    // kintone Webhookからのリクエスト
    if (e.parameter && e.parameter.secret) {
      return handleKintoneWebhook_(e);
    }

    // サブからのメール受信
    if (action === 'ingestMail') {
      if (secret !== prop_('SUB_SHARED_SECRET')) {
        return jsonResponse_({ ok: false, message: '認証エラー' });
      }
      enqueueMail_(payload);
      return jsonResponse_({ ok: true });
    }

    // kintoneからのエリア回答
    if (action === 'todoAreaAnswer') {
      return handleAreaAnswer_(payload);
    }

    // ===== KPC2 ジョブキュー API（09_area_request.gs） =====
    // areaNext / areaDone / areaFail / areaAsk の認証チェックは各ハンドラで行う
    const areaRes = routeAreaAction_(action, payload, secret);
    if (areaRes) return areaRes;

    // 疎通確認
    if (action === 'ping') {
      return jsonResponse_({ ok: true, message: 'pong' });
    }

    return jsonResponse_({ ok: false, message: '不明なアクション: ' + action });
  } catch (err) {
    console.error('doPost エラー:', err.message, err.stack);
    return jsonResponse_({ ok: false, message: err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== メールキュー =====

function enqueueMail_(payload) {
  const sheetId = prop_('SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('queue');
  const id = Utilities.getUuid();
  sheet.appendRow([id, JSON.stringify(payload), new Date().toISOString(), 'pending']);
  console.log('メールをキューに追加:', id, payload.subject);
}

function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('キュー処理: ロック取得できず、スキップ');
    return;
  }
  try {
    const sheetId = prop_('SHEET_ID');
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName('queue');
    const rows = sheet.getDataRange().getValues();
    let processed = 0;
    for (let i = 1; i < rows.length; i++) {
      if (processed >= CONFIG.MAX_MAILS_PER_RUN) break;
      const [id, payloadStr, createdAt, status] = rows[i];
      if (status !== 'pending') continue;
      // 処理中に変更
      sheet.getRange(i + 1, 4).setValue('processing');
      try {
        const payload = JSON.parse(payloadStr);
        processOneMail_(payload);
        sheet.getRange(i + 1, 4).setValue('done');
        processed++;
      } catch (err) {
        console.error('メール処理エラー:', err.message);
        sheet.getRange(i + 1, 4).setValue('error: ' + err.message.slice(0, 100));
      }
    }
    // 古い完了/エラー行を削除（3日以上前）
    cleanupQueue_(sheet);
    console.log('キュー処理完了:', processed, '件');
  } finally {
    lock.releaseLock();
  }
}

function cleanupQueue_(sheet) {
  const rows = sheet.getDataRange().getValues();
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  for (let i = rows.length - 1; i >= 1; i--) {
    const [id, payload, createdAt, status] = rows[i];
    if ((status === 'done' || status.startsWith('error')) && new Date(createdAt).getTime() < cutoff) {
      sheet.deleteRow(i + 1);
    }
  }
}

// ===== メール処理 =====

function processOneMail_(payload) {
  const { mailbox, gmailId, rfcId, from, to, date, subject, body, bodyTruncated, attachments, skippedAttachments } = payload;

  console.log('メール処理開始:', subject, 'from:', from);

  // 重複チェック（同じgmailIdがTodoに既にある場合はスキップ）
  if (gmailId && isTodoDuplicate_(gmailId)) {
    console.log('重複スキップ:', gmailId);
    return;
  }

  // Claude APIでメール分析
  const analysis = analyzeMailWithClaude_(payload);

  // kintoneにToDoレコードを作成
  const todoRecord = createTodoRecord_(payload, analysis);
  const todoId = todoRecord.id;

  console.log('ToDo作成:', todoId, '/', analysis.category, '/', analysis.action);

  // エリア表自動実行
  const autoCategories = getAutoAreaCategories_();
  if (analysis.action === 'エリア表作成' || autoCategories.indexOf(analysis.category) >= 0) {
    try {
      triggerAreaCreation_(todoId, payload, analysis);
    } catch (err) {
      console.error('エリア表自動実行エラー:', err.message);
      updateTodoAreaStatus_(todoId, '失敗', null, err.message);
    }
  }
}

function isTodoDuplicate_(gmailId) {
  try {
    const token = prop_('KINTONE_TOKEN_TODO');
    const query = 'gmail_id = "' + gmailId + '"';
    const url = 'https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/records.json?app=' + CONFIG.APP.TODO + '&query=' + encodeURIComponent(query) + '&totalCount=true';
    const res = UrlFetchApp.fetch(url, {
      headers: { 'X-Cybozu-API-Token': token },
      muteHttpExceptions: true,
    });
    const json = JSON.parse(res.getContentText());
    return json.totalCount > 0;
  } catch (e) {
    return false;
  }
}

// ===== Claude API =====

function analyzeMailWithClaude_(payload) {
  const { from, to, subject, body, attachments, mailbox } = payload;

  // 顧客マスタを取得して判断材料にする（件数が多いので上位100件）
  let customerList = '';
  try {
    const customers = kintoneGetRecords_(CONFIG.APP.CUSTOMER, prop_('KINTONE_TOKEN_CUSTOMER'), '', ['name'], 100);
    customerList = customers.map(function (r) { return r.name.value; }).join('、');
  } catch (e) {
    customerList = '（取得失敗）';
  }

  const prompt = `あなたはエリマーケット株式会社のメール処理AIです。
以下のメールを分析し、JSON形式で回答してください。

【メール情報】
差出人: ${from}
宛先: ${to}（${mailbox}に届いたメール）
件名: ${subject}
本文:
${body.slice(0, 3000)}
${body.length > 3000 ? '（以下省略）' : ''}

【既存取引先一覧】
${customerList}

【判断基準】
- category: このメールの種類を以下から選んでください
  - 新規問い合わせ（エリア表作成の可能性が高い）
  - 既存案件連絡（進行中の案件に関する連絡）
  - 見積依頼（見積書作成が必要）
  - 注文確認（発注確認）
  - エリア表作成（エリア表作成の明確な依頼）
  - 情報共有（特にアクション不要）
  - その他

- action: 推奨アクションを以下から選んでください
  - エリア表作成（担当者確認・案件登録・エリア表作成が必要）
  - 見積作成（見積書作成が必要）
  - 返信必要（担当者が返信すべきメール）
  - 確認のみ（内容確認だけでよい）
  - スキップ（対応不要の自動通知等）

- summary: メールの要約（100文字以内）
- customerName: 既存取引先に一致する場合その名前、なければnull
- personName: 担当者名（メールから読み取れる場合）
- isNewCustomer: true/false（既存取引先に一致しない新規の可能性が高い場合true）

JSONのみ回答してください。コードブロックなし。`;

  try {
    const apiKey = prop_('CLAUDE_API_KEY');
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      payload: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
        thinking: { type: 'enabled', budget_tokens: 2000 },
        messages: [{ role: 'user', content: prompt }],
      }),
      muteHttpExceptions: true,
    });
    const json = JSON.parse(res.getContentText());
    if (json.error) throw new Error(json.error.message);
    // thinkingブロックを除いたtextブロックを取得
    const textBlock = (json.content || []).find(function (b) { return b.type === 'text'; });
    const text = textBlock ? textBlock.text : '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error('Claude API エラー:', err.message);
    return {
      category: 'その他',
      action: '確認のみ',
      summary: '（AI分析失敗: ' + err.message.slice(0, 50) + '）',
      customerName: null,
      personName: null,
      isNewCustomer: false,
    };
  }
}

// ===== kintone ToDo作成 =====

function createTodoRecord_(payload, analysis) {
  const { mailbox, gmailId, rfcId, from, to, date, subject, body } = payload;
  const token = prop_('KINTONE_TOKEN_TODO');

  const record = {
    subject:  { value: subject  || '' },
    from:     { value: from     || '' },
    to:       { value: to       || '' },
    date:     { value: date     || '' },
    body:     { value: body ? body.slice(0, 10000) : '' },
    gmail_id: { value: gmailId  || '' },
    rfc_id:   { value: rfcId    || '' },
    mailbox:  { value: mailbox  || '' },
    status:   { value: '未対応' },
    category: { value: analysis.category || 'その他' },
    summary:  { value: analysis.summary  || '' },
    action:   { value: analysis.action   || '確認のみ' },
  };

  const res = UrlFetchApp.fetch('https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/record.json', {
    method: 'post',
    headers: {
      'X-Cybozu-API-Token': token,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({ app: CONFIG.APP.TODO, record: record }),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (json.code) throw new Error('kintone ToDo作成エラー: ' + json.message);
  return json;
}

function updateTodoAreaStatus_(todoId, areaStatus, areaRecordId, areaQuestion) {
  const token = prop_('KINTONE_TOKEN_TODO');
  const record = {
    area_status: { value: areaStatus },
  };
  if (areaRecordId)  record.area_record_id = { value: String(areaRecordId) };
  if (areaQuestion)  record.area_question  = { value: areaQuestion };

  const res = UrlFetchApp.fetch('https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/record.json', {
    method: 'put',
    headers: {
      'X-Cybozu-API-Token': token,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({ app: CONFIG.APP.TODO, id: todoId, record: record }),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (json.code) throw new Error('kintone ToDo更新エラー: ' + json.message);
  return json;
}

// ===== エリア表作成（新方式：ジョブキュー経由） =====
// 09_area_request.gs の enqueueAreaJob_ に委譲する。
// 旧方式（App 75 直接作成）は削除済み。

function triggerAreaCreation_(todoId, payload, analysis) {
  console.log('エリア表作成開始（キュー経由）: todoId=' + todoId);
  enqueueAreaJob_(todoId, payload, analysis, 'お客様メール');
}

// ===== エリア表回答処理（kintoneからWebhook or kintone JS経由） =====
// 09_area_request.gs の reenqueueAreaJob_ に委譲する。

function handleAreaAnswer_(payload) {
  const { recordId, answer, user } = payload;
  if (!recordId || !answer) {
    return jsonResponse_({ ok: false, message: 'recordId と answer が必要です' });
  }
  try {
    // area_answer フィールドに回答を保存
    const token = prop_('KINTONE_TOKEN_TODO');
    const updateRes = UrlFetchApp.fetch('https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/record.json', {
      method: 'put',
      headers: { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' },
      payload: JSON.stringify({
        app: CONFIG.APP.TODO,
        id: recordId,
        record: { area_answer: { value: answer } },
      }),
      muteHttpExceptions: true,
    });
    const updateJson = JSON.parse(updateRes.getContentText());
    if (updateJson.code) throw new Error(updateJson.message);

    // area_asking から取り出してキューに再投入
    reenqueueAreaJob_(recordId, answer);

    return jsonResponse_({ ok: true, message: '回答を受け取り、エリア表作成を再開しました' });
  } catch (err) {
    console.error('handleAreaAnswer_ エラー:', err.message);
    return jsonResponse_({ ok: false, message: err.message });
  }
}

// ===== kintone Webhook（App 75 後方互換） =====

function handleKintoneWebhook_(e) {
  // kintone Webhookからのリクエスト（App 75の状態変化）
  const kintoneSecret = propOrEmpty_('KINTONE_SHARED_SECRET');
  if (kintoneSecret && e.parameter.secret !== kintoneSecret) {
    return jsonResponse_({ ok: false, message: '認証エラー' });
  }

  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const record    = body.record || {};
    const areaStatus = record.status          && record.status.value          || '';
    const todoId     = record.source_todo_id  && record.source_todo_id.value  || '';
    const areaId     = record.$id             && record.$id.value             || '';

    if (!todoId) return jsonResponse_({ ok: true, message: 'source_todo_id なし、スキップ' });

    if (areaStatus === '完了') {
      updateTodoAreaStatus_(todoId, '完了', areaId, null);
      console.log('エリア表完了通知（旧方式）: todoId=' + todoId + ', areaId=' + areaId);
    } else if (areaStatus === '失敗') {
      const errorMsg = record.error_message && record.error_message.value || '';
      updateTodoAreaStatus_(todoId, '失敗', areaId, errorMsg);
      console.log('エリア表失敗通知（旧方式）: todoId=' + todoId);
    }

    return jsonResponse_({ ok: true });
  } catch (err) {
    console.error('handleKintoneWebhook_ エラー:', err.message);
    return jsonResponse_({ ok: false, message: err.message });
  }
}

// ===== kintone API ユーティリティ =====

function kintoneGetRecords_(appId, token, query, fields, limit) {
  const params = ['app=' + appId];
  if (query) params.push('query=' + encodeURIComponent(query + ' limit ' + (limit || 100)));
  if (fields && fields.length) params.push('fields%5B%5D=' + fields.join('&fields%5B%5D='));
  const url = 'https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/records.json?' + params.join('&');
  const res = UrlFetchApp.fetch(url, {
    headers: { 'X-Cybozu-API-Token': token },
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (json.code) throw new Error('kintone取得エラー: ' + json.message);
  return json.records || [];
}

// ===== Gmail監視（jimukyoku@で直接scanMailboxも動かす） =====

function doneKey_(d) {
  return 'pdone_' + Utilities.formatDate(d || new Date(), 'Asia/Tokyo', 'yyyyMMdd');
}

function loadDoneIds_(props) {
  const all = props.getProperties();
  const set = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('pdone_') === 0) all[k].split(',').forEach(function (id) { if (id) set[id] = 1; });
  });
  return set;
}

function markDone_(props, id) {
  const key = doneKey_();
  const cur = props.getProperty(key) || '';
  props.setProperty(key, cur ? cur + ',' + id : id);
}

function cleanupProcessedIds_(props) {
  const keep = {};
  for (let i = 0; i < 4; i++) keep[doneKey_(new Date(Date.now() - i * 86400000))] = 1;
  const all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('pdone_') === 0 && !keep[k]) props.deleteProperty(k);
  });
}

function scanMailbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const label   = GmailApp.getUserLabelByName(CONFIG.LABEL_DONE) || GmailApp.createLabel(CONFIG.LABEL_DONE);
    const props   = PropertiesService.getScriptProperties();
    const mailbox = Session.getEffectiveUser().getEmail();
    const threads = GmailApp.search(CONFIG.GMAIL_QUERY, 0, 30);
    const since   = Math.max(Number(props.getProperty('START_AT')) || 0, Date.now() - 2 * 24 * 60 * 60 * 1000);
    const done    = loadDoneIds_(props);
    let count = 0;

    for (let t = 0; t < threads.length && count < CONFIG.MAX_MAILS_PER_RUN; t++) {
      const messages = threads[t].getMessages();
      for (let m = 0; m < messages.length && count < CONFIG.MAX_MAILS_PER_RUN; m++) {
        const msg = messages[m];
        const mid = msg.getId();
        if (done[mid] || props.getProperty('p_' + mid)) continue;

        const from      = msg.getFrom() || '';
        const fromLower = from.toLowerCase();
        const skip      = msg.getDate().getTime() < since ||
          fromLower.indexOf(mailbox.toLowerCase()) >= 0 ||
          CONFIG.SKIP_FROM.some(function (s) { return fromLower.indexOf(s) >= 0; });

        if (!skip) {
          const payload = buildMailPayload_(msg, mailbox);
          enqueueMail_(payload);
          count++;
        }
        markDone_(props, mid);
        done[mid] = 1;
      }
      threads[t].addLabel(label);
    }
    cleanupProcessedIds_(props);
  } catch (e) {
    if (typeof notifyError_ === 'function') notifyError_('Gmail監視', e); else throw e;
  } finally {
    lock.releaseLock();
  }
}

function buildMailPayload_(msg, mailbox) {
  let body      = msg.getPlainBody() || '';
  let truncated = false;
  if (body.length > CONFIG.MAX_BODY_CHARS) {
    body = body.slice(0, CONFIG.MAX_BODY_CHARS);
    truncated = true;
  }
  const attachments = [];
  const skipped     = [];
  msg.getAttachments({ includeInlineImages: false }).forEach(function (a) {
    const type = a.getContentType();
    const ok   = type === 'application/pdf' || /^image\/(jpeg|png|gif|webp)$/.test(type);
    if (!ok)                              { skipped.push(a.getName() + ' (形式対象外)'); return; }
    if (a.getSize() > CONFIG.MAX_ATTACH_BYTES) { skipped.push(a.getName() + ' (大きすぎ)'); return; }
    attachments.push({ name: a.getName(), mimeType: type, base64: Utilities.base64Encode(a.getBytes()) });
  });
  return {
    mailbox:            mailbox,
    gmailId:            msg.getId(),
    rfcId:              msg.getHeader('Message-ID') || msg.getId(),
    from:               msg.getFrom(),
    to:                 msg.getTo(),
    date:               Utilities.formatDate(msg.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
    subject:            msg.getSubject(),
    body:               body,
    bodyTruncated:      truncated,
    attachments:        attachments,
    skippedAttachments: skipped,
  };
}

// ===== エラー通知 =====

function notifyError_(context, err) {
  console.error('[ERROR] ' + context + ': ' + err.message + '\n' + (err.stack || ''));
  try {
    const cwToken = propOrEmpty_('CW_TOKEN');
    const cwRoom  = propOrEmpty_('CW_ROOM_ORDER');
    if (!cwToken || !cwRoom) return;
    const msg = '[KPC2エラー] ' + context + '\n' + err.message.slice(0, 200);
    UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/' + cwRoom + '/messages', {
      method: 'post',
      headers: { 'X-ChatWorkToken': cwToken },
      payload: 'body=' + encodeURIComponent(msg),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.error('エラー通知失敗:', e.message);
  }
}

// ===== ヘルパー =====

function getAutoAreaCategories_() {
  const v = propOrEmpty_('TODO_AUTO_AREA_CATEGORIES');
  if (!v) return CONFIG.AUTO_AREA_CATEGORIES;
  return v.split(',').map(function (s) { return s.trim(); });
}

// ===== セットアップユーティリティ =====

// WebアプリURL（全員アクセス可・匿名含む）をスクリプトプロパティに設定する
function setWebappUrl() {
  PropertiesService.getScriptProperties()
    .setProperty('WEBAPP_URL', 'https://script.google.com/macros/s/AKfycby6F8KFRNv3k3wVxPYNrEL-7ODcAhWU3tg9BFlKi5q3Dr6vXBgnA1u0GRNMjtyH_9U/exec');
  Logger.log('WEBAPP_URL設定完了');
}

// KintoneのAPIトークンをスクリプトプロパティに設定する（App212: ToDo受信メール / App75: エリア表）
function setKintoneTokens() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('KINTONE_TOKEN_TODO', '<App212のAPIトークン>');
  p.setProperty('KINTONE_TOKEN_AREA', '<App75のAPIトークン>');
  Logger.log('Kintoneトークン設定完了');
}
