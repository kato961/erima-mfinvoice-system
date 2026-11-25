// ===================================================
// 09_area_request.gs
// KPC2 エリア表作成 ジョブキュー（本体側）
//
// - enqueueAreaJob_       : メール/社内依頼→ジョブを area_queue シートに積む
// - reenqueueAreaJob_     : 要確認回答後に再エンキュー（枝番付き）
// - handleAreaNext_       : KPC2 が 2 分ポーリングして次ジョブを取得
// - handleAreaDone_       : KPC2 から完了通知（files, summary）
// - handleAreaFail_       : KPC2 から失敗通知（reason）
// - handleAreaAsk_        : KPC2 から確認質問（新設）→ ToDo「要確認」へ
//
// doPost ルーティング: kpc2-main.gs の doPost から routeAreaAction_ に委譲。
// ===================================================

const AR_QUEUE          = 'area_queue';    // スプレッドシート: ジョブキューシート名
const AR_ASKING         = 'area_asking';   // スプレッドシート: 要確認保留シート名
const AR_INSTRUCT_SHEET = 'KPC2手順書';   // スプレッドシート: KPC2手順書シート（A1 に全文）
const AR_CW_MAP_SHEET   = '211';           // スプレッドシート: 社内依頼者→Chatwork宛先マップ

// ============================================================
// doPost ルーティングの委譲先（kpc2-main.gs から呼ぶ）
// ============================================================

function routeAreaAction_(action, payload, secret) {
  if (action === 'areaNext') return handleAreaNext_(secret);
  if (action === 'areaDone') return handleAreaDone_(payload);
  if (action === 'areaFail') return handleAreaFail_(payload);
  if (action === 'areaAsk')  return handleAreaAsk_(payload);
  return null;
}

// ============================================================
// enqueueAreaJob_
// triggerAreaCreation_() から呼ばれる。
// Claude で job 仕様を抽出し、area_queue シートに積む。
// 情報不足の場合は直接「要確認」状態にして area_asking に保留。
// ============================================================

function enqueueAreaJob_(todoId, payload, analysis, source) {
  source = source || 'お客様メール';
  const baseId = 'TD' + todoId;

  // Claude でジョブ仕様（center / mode / copies … ）を抽出
  const spec = extractJobSpec_(payload, analysis, source);

  if (spec.needsQuestion) {
    // 情報不足：ToDo を要確認にして area_asking に保留
    updateTodoAreaStatus_(todoId, '要確認', null, spec.question || '情報が不足しています');
    storeAskingJob_(baseId, spec, payload, source);
    console.log('enqueueAreaJob_ 要確認 todoId=' + todoId + ' q=' + spec.question);
    return;
  }

  const job = buildAreaJob_(baseId, spec, payload, source, []);
  pushAreaQueue_(job);
  updateTodoAreaStatus_(todoId, '作成待ち', null, null);
  console.log('enqueueAreaJob_ 積み完了 id=' + baseId);
}

// ============================================================
// reenqueueAreaJob_
// handleAreaAnswer_ から呼ばれる。
// area_asking の保留ジョブに answers を追加して枝番付き ID で再エンキュー。
// ============================================================

function reenqueueAreaJob_(todoId, answer) {
  const baseId = 'TD' + todoId;
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const askSheet = ss.getSheetByName(AR_ASKING);

  if (!askSheet) {
    console.warn('reenqueueAreaJob_: asking シートなし todoId=' + todoId);
    return;
  }

  const rows = askSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== baseId) continue;

    const prevSpec     = JSON.parse(rows[i][1]);
    const prevPayload  = JSON.parse(rows[i][2]);
    const prevSource   = String(rows[i][3]);
    const prevAnswers  = JSON.parse(rows[i][4] || '[]');

    // 枝番付き ID（TD95 → TD95-2 → TD95-3 …）
    const branch = getNextBranchNumber_(ss, baseId);
    const newId  = branch <= 1 ? baseId : baseId + '-' + branch;

    const newAnswers = prevAnswers.concat([answer]);
    const job = buildAreaJob_(newId, prevSpec, prevPayload, prevSource, newAnswers);
    pushAreaQueue_(job);

    // asking 行を削除
    askSheet.deleteRow(i + 1);

    updateTodoAreaStatus_(todoId, '作成待ち', null, null);
    console.log('reenqueueAreaJob_ 再エンキュー newId=' + newId);
    return;
  }

  console.warn('reenqueueAreaJob_: asking ジョブが見つかりません baseId=' + baseId);
}

// ============================================================
// handleAreaNext_
// KPC2 が 2 分ごとにポーリング。
// pending の最古ジョブを processing に変えて返す。なければ job: null。
// ============================================================

function handleAreaNext_(secret) {
  if (secret !== prop_('SUB_SHARED_SECRET')) {
    return jsonResponse_({ ok: false, message: '認証エラー' });
  }

  const ss    = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const sheet = getOrCreateSheet_(ss, AR_QUEUE, ['id', 'job', 'created_at', 'status']);
  const rows  = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][3] !== 'pending') continue;

    // processing に更新
    sheet.getRange(i + 1, 4).setValue('processing');

    const job = JSON.parse(rows[i][1]);

    // KPC2手順書を管理シートから補完
    job.instructions = getKpc2Instructions_(ss);

    // ToDo を作業中に更新
    const todoId = getTodoIdFromJobId_(job.id);
    updateTodoAreaStatus_(todoId, '作業中', null, null);

    return jsonResponse_({ ok: true, job: job });
  }

  return jsonResponse_({ ok: true, job: null });
}

// ============================================================
// handleAreaDone_
// KPC2 から完了通知。
// payload: { id, files:[{name, mimeType, base64}], savedPath, summary, note? }
// replyBody は受け取らない（送らない）。
// ============================================================

function handleAreaDone_(payload) {
  const { id, files, summary, note } = payload;
  if (!id) return jsonResponse_({ ok: false, message: 'id が必要です' });

  const todoId = getTodoIdFromJobId_(id);

  try {
    // ファイルを Google Drive に保存
    let driveUrl = '';
    if (files && files.length > 0) {
      driveUrl = saveAreaFilesToDrive_(id, files);
    }

    // ToDo を完了に更新（summary + driveUrl）
    updateTodoAreaDone_(todoId, summary || '', driveUrl);

    // Chatwork 通知（完了・1 回のみ）
    notifyAreaChatwork_(todoId, '完了', summary || '', driveUrl);

    // キューを done に
    setAreaQueueStatus_(id, 'done');

    console.log('handleAreaDone_ 完了 id=' + id + ' todoId=' + todoId);
    return jsonResponse_({ ok: true });
  } catch (err) {
    console.error('handleAreaDone_ エラー:', err.message);
    return jsonResponse_({ ok: false, message: err.message });
  }
}

// ============================================================
// handleAreaFail_
// KPC2 から失敗通知。
// payload: { id, reason }
// ============================================================

function handleAreaFail_(payload) {
  const { id, reason } = payload;
  if (!id) return jsonResponse_({ ok: false, message: 'id が必要です' });

  const todoId = getTodoIdFromJobId_(id);

  try {
    updateTodoAreaStatus_(todoId, '失敗', null, reason || '原因不明');
    notifyAreaChatwork_(todoId, '失敗', reason || '', '');
    setAreaQueueStatus_(id, 'failed');

    console.log('handleAreaFail_ 失敗 id=' + id + ' reason=' + reason);
    return jsonResponse_({ ok: true });
  } catch (err) {
    console.error('handleAreaFail_ エラー:', err.message);
    return jsonResponse_({ ok: false, message: err.message });
  }
}

// ============================================================
// handleAreaAsk_（新設）
// KPC2 から確認質問。
// payload: { id, question, missing:[] }
// → ToDo「要確認」+ area_queue 行を area_asking に移動。
// ============================================================

function handleAreaAsk_(payload) {
  const { id, question, missing } = payload;
  if (!id || !question) {
    return jsonResponse_({ ok: false, message: 'id と question が必要です' });
  }

  const todoId = getTodoIdFromJobId_(id);

  try {
    // ToDo を要確認状態に（question を area_question フィールドに保存）
    updateTodoAreaStatus_(todoId, '要確認', null, question);

    // area_queue の行を area_asking に移動（answer 待ち）
    moveQueueRowToAsking_(id, question);

    console.log('handleAreaAsk_ 要確認 id=' + id + ' q=' + question);
    return jsonResponse_({ ok: true });
  } catch (err) {
    console.error('handleAreaAsk_ エラー:', err.message);
    return jsonResponse_({ ok: false, message: err.message });
  }
}

// ============================================================
// extractJobSpec_
// Claude でメール/依頼から job の各キーを抽出する。
// center と mode が不明なら needsQuestion=true。
// ============================================================

function extractJobSpec_(payload, analysis, source) {
  const isSocial  = source === '社内依頼';
  const bodyText  = (payload.body || '').slice(0, 2000);

  const prompt =
'あなたはポスティング会社エリアマーケットのエリア表作成システムです。\n' +
'以下の' + (isSocial ? '社内依頼' : 'お客様メール') + 'からエリア表作成ジョブの仕様を抽出してください。\n\n' +
'【依頼内容】\n' +
(isSocial ? '（社内依頼）\n' : '差出人: ' + (payload.from || '') + '\n') +
'件名: ' + (payload.subject || '') + '\n' +
'本文:\n' + bodyText + '\n\n' +
'【抽出ルール】\n' +
'- center: 配布の中心地点（住所・店名・駅名）。複数は配列で。最重要項目。\n' +
'- mode: "部数" / "半径" / "地域指定" の3値のみ。\n' +
'- copies: mode=部数のとき枚数（整数）。\n' +
'- radius_m: mode=半径のとき半径メートル（整数）。\n' +
'- areas: mode=地域指定のとき町丁目名の配列。\n' +
'- housing: "軒並み" / "集合住宅のみ" / "戸建のみ"（言及なければnull）。\n' +
'- notes: 除外エリアや特記事項（なければnull）。\n' +
'- target: ターゲット層（言及なければnull）。\n' +
'- center と mode のどちらかが不明なら needsQuestion=true にすること。\n\n' +
'以下の JSON 形式のみで回答してください（コードブロック不要）:\n' +
'{\n' +
'  "needsQuestion": false,\n' +
'  "question": null,\n' +
'  "missing": [],\n' +
'  "housing": null,\n' +
'  "notes": null,\n' +
'  "center": "○○駅",\n' +
'  "mode": "部数",\n' +
'  "copies": null,\n' +
'  "radius_m": null,\n' +
'  "areas": null,\n' +
'  "target": null\n' +
'}';

  try {
    const apiKey = prop_('CLAUDE_API_KEY');
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
      muteHttpExceptions: true,
    });
    const json = JSON.parse(res.getContentText());
    if (json.error) throw new Error(json.error.message);
    return JSON.parse(json.content[0].text);
  } catch (err) {
    return {
      needsQuestion: true,
      question:
        'エリア表作成に必要な「配布中心地」と「部数・半径・地域」が確認できませんでした。' +
        '教えてください。（自動抽出エラー: ' + err.message.slice(0, 80) + '）',
      missing: ['center', 'mode'],
    };
  }
}

// ============================================================
// buildAreaJob_
// job オブジェクトを組み立てる。instructions は areaNext 時に補完。
// ============================================================

function buildAreaJob_(id, spec, payload, source, answers) {
  const isSocial     = source === '社内依頼';
  const mailPrefix   = isSocial ? '【社内依頼】エリア表の作成\n' : '';
  const mailBody     = mailPrefix + (payload.body || '').slice(0, 10000);

  return {
    id:           id,
    source:       source,                     // お客様メール / 社内依頼
    kind:         'エリア表',
    housing:      spec.housing  || null,
    notes:        spec.notes    || null,
    answers:      answers       || [],
    center:       spec.center,
    mode:         spec.mode,
    copies:       spec.copies   || null,
    radius_m:     spec.radius_m || null,
    areas:        spec.areas    || null,
    target:       spec.target   || null,
    mailBody:     mailBody,
    instructions: '',                         // areaNext 時に管理シートから補完
  };
}

// ============================================================
// スプレッドシート操作ヘルパー
// ============================================================

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function pushAreaQueue_(job) {
  const ss    = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const sheet = getOrCreateSheet_(ss, AR_QUEUE, ['id', 'job', 'created_at', 'status']);
  sheet.appendRow([job.id, JSON.stringify(job), new Date().toISOString(), 'pending']);
}

function setAreaQueueStatus_(id, status) {
  const ss    = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const sheet = ss.getSheetByName(AR_QUEUE);
  if (!sheet) return;
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.getRange(i + 1, 4).setValue(status);
      return;
    }
  }
}

// area_queue の行を area_asking に移動（areaAsk 受信時）
function moveQueueRowToAsking_(id, question) {
  const ss     = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const qSheet = ss.getSheetByName(AR_QUEUE);
  if (!qSheet) return;

  const rows = qSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(id)) continue;

    const job      = JSON.parse(rows[i][1]);
    const askSheet = getOrCreateSheet_(ss, AR_ASKING,
      ['id', 'jobSpec', 'payload', 'source', 'answers', 'question', 'created_at']);

    // jobSpec = job をそのまま保存。payload は mailBody を代用。
    askSheet.appendRow([
      id,
      JSON.stringify(job),
      JSON.stringify({ body: job.mailBody, subject: '', from: '' }),
      job.source,
      JSON.stringify(job.answers || []),
      question,
      new Date().toISOString(),
    ]);

    // キューからは削除（asking で管理）
    qSheet.deleteRow(i + 1);
    return;
  }
}

// enqueueAreaJob_ で情報不足のまま初回エンキューを断念した場合の保留保存
function storeAskingJob_(baseId, spec, payload, source) {
  const ss       = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const askSheet = getOrCreateSheet_(ss, AR_ASKING,
    ['id', 'jobSpec', 'payload', 'source', 'answers', 'question', 'created_at']);
  askSheet.appendRow([
    baseId,
    JSON.stringify(spec),
    JSON.stringify(payload),
    source,
    JSON.stringify([]),
    spec.question || '',
    new Date().toISOString(),
  ]);
}

// 次の枝番（TD95 の場合: 1回目=1(TD95), 2回目=2(TD95-2), …）
function getNextBranchNumber_(ss, baseId) {
  let max = 1;
  const qs = ss.getSheetByName(AR_QUEUE);
  if (qs) {
    qs.getDataRange().getValues().slice(1).forEach(function(r) {
      const rid = String(r[0]);
      if (rid === baseId) {
        max = Math.max(max, 2);
      } else if (rid.indexOf(baseId + '-') === 0) {
        const n = parseInt(rid.split('-').pop(), 10);
        if (!isNaN(n)) max = Math.max(max, n + 1);
      }
    });
  }
  return max;
}

// ============================================================
// KPC2手順書取得（管理シート「KPC2手順書」A1 の全文）
// ============================================================

function getKpc2Instructions_(ss) {
  try {
    ss = ss || SpreadsheetApp.openById(prop_('SHEET_ID'));
    const sheet = ss.getSheetByName(AR_INSTRUCT_SHEET);
    if (!sheet) return '';
    return String(sheet.getRange('A1').getValue() || '');
  } catch (e) {
    console.warn('getKpc2Instructions_ 取得失敗:', e.message);
    return '';
  }
}

// ============================================================
// kintone ToDo 更新
// ============================================================

// 完了時：area_question フィールドに summary + driveUrl を書き込む
function updateTodoAreaDone_(todoId, summary, driveUrl) {
  const token = prop_('KINTONE_TOKEN_TODO');
  const display = [summary, driveUrl].filter(Boolean).join('\n');
  const record = {
    area_status:   { value: '完了' },
    area_question: { value: display },
  };
  const res = UrlFetchApp.fetch('https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/record.json', {
    method: 'put',
    headers: { 'X-Cybozu-API-Token': token, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ app: CONFIG.APP.TODO, id: parseInt(todoId, 10), record: record }),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (json.code) throw new Error('kintone ToDo完了更新エラー: ' + json.message);
}

// ============================================================
// Google Drive 保存（areaDone の files）
// ============================================================

function saveAreaFilesToDrive_(jobId, files) {
  const folderName =
    'エリア表_' + jobId + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');

  let folder;
  try {
    const parentId = propOrEmpty_('AREA_DRIVE_FOLDER_ID');
    const parent   = parentId ? DriveApp.getFolderById(parentId) : DriveApp.getRootFolder();
    folder = parent.createFolder(folderName);
  } catch (e) {
    folder = DriveApp.getRootFolder().createFolder(folderName);
  }

  files.forEach(function(f) {
    if (!f.base64 || !f.name) return;
    const bytes = Utilities.base64Decode(f.base64);
    const blob  = Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream', f.name);
    folder.createFile(blob);
  });

  return folder.getUrl();
}

// ============================================================
// Chatwork 通知（完了・失敗のみ、1 回）
// ============================================================

function notifyAreaChatwork_(todoId, result, detail, driveUrl) {
  try {
    const cwToken = propOrEmpty_('CW_TOKEN');
    if (!cwToken) return;

    // ToDoレコードを取得して件名・source を確認
    const token  = prop_('KINTONE_TOKEN_TODO');
    const getRes = UrlFetchApp.fetch(
      'https://' + CONFIG.KINTONE_DOMAIN + '/k/v1/record.json?app=' + CONFIG.APP.TODO + '&id=' + todoId,
      { headers: { 'X-Cybozu-API-Token': token }, muteHttpExceptions: true }
    );
    const rec     = JSON.parse(getRes.getContentText()).record || {};
    const subject = (rec.subject  && rec.subject.value)  || '';
    const fromVal = (rec.from     && rec.from.value)     || '';
    const bodyVal = (rec.body     && rec.body.value)     || '';

    // 社内依頼かどうか判定
    const isSocial =
      bodyVal.indexOf('【社内依頼】') === 0 ||
      (rec.mailbox && rec.mailbox.value === 'jimukyoku@erima.co');

    // Chatwork 宛先を決定（社内依頼なら 211 シートで引く）
    let cwRoom = propOrEmpty_('CW_ROOM_ORDER');
    if (isSocial) {
      cwRoom = getSocialCwRoom_(fromVal) || cwRoom;
    }
    if (!cwRoom) return;

    const icon = result === '完了' ? '[info]' : '[dtext:exclamation]';
    let msg    = icon + '[title]エリア表 ' + result + '[/title]\n';
    msg += 'ID: TD' + todoId + '\n';
    msg += '件名: ' + subject.slice(0, 50) + '\n';
    if (detail)   msg += '詳細: ' + String(detail).slice(0, 100) + '\n';
    if (driveUrl) msg += 'ファイル: ' + driveUrl + '\n';

    UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/' + cwRoom + '/messages', {
      method: 'post',
      headers: { 'X-ChatWorkToken': cwToken },
      payload: 'body=' + encodeURIComponent(msg),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.warn('notifyAreaChatwork_ 失敗:', e.message);
  }
}

// 管理シート 211（社内依頼者メール → Chatwork ルームID）を引く
function getSocialCwRoom_(fromEmail) {
  try {
    const ss    = SpreadsheetApp.openById(prop_('SHEET_ID'));
    const sheet = ss.getSheetByName(AR_CW_MAP_SHEET);
    if (!sheet) return null;
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] &&
          String(rows[i][0]).toLowerCase() === fromEmail.toLowerCase()) {
        return String(rows[i][1]);
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// ユーティリティ
// ============================================================

// 'TD95' or 'TD95-2' → '95'
function getTodoIdFromJobId_(jobId) {
  return String(jobId).replace(/^TD/, '').split('-')[0];
}

// ============================================================
// セットアップユーティリティ（手動実行）
// ============================================================

// 管理シート 211（社内依頼者→Chatwork宛先）を初期化する
function setupAreaCwMapSheet() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  let sheet = ss.getSheetByName(AR_CW_MAP_SHEET);
  if (!sheet) sheet = ss.insertSheet(AR_CW_MAP_SHEET);

  sheet.getRange('A1').setValue('メールアドレス（社内依頼者）');
  sheet.getRange('B1').setValue('Chatwork ルームID');

  // 既存スタッフ分のサンプル行（ルームIDは空欄で確認・記入してください）
  const staffRows = [
    ['kato@erima.co',  ''],
    ['mori@erima.co',  ''],
  ];
  staffRows.forEach(function(row, idx) {
    if (sheet.getLastRow() < idx + 2) {
      sheet.appendRow(row);
    }
  });

  console.log('setupAreaCwMapSheet 完了: シート「' + AR_CW_MAP_SHEET + '」');
}

// 管理シート「KPC2手順書」を初期化する（A1 に手順書本文を貼り付けてください）
function setupKpc2InstructionsSheet() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  let sheet = ss.getSheetByName(AR_INSTRUCT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(AR_INSTRUCT_SHEET);
    sheet.getRange('A1').setValue(
      '（KPC2 SKILL.md の内容をこのセルに貼り付けてください）\n' +
      '※ areaNext が呼ばれるたびにこのセルの内容が job.instructions として KPC2 に渡されます。'
    );
    console.log('setupKpc2InstructionsSheet 完了: シート「' + AR_INSTRUCT_SHEET + '」に A1 プレースホルダーを設置しました');
  } else {
    console.log('setupKpc2InstructionsSheet: シート「' + AR_INSTRUCT_SHEET + '」は既に存在します');
  }
}
