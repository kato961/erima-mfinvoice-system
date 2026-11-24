/**
 * Kintone MF請求書連携 メインファイル
 * kintone-mfinvoice-project-config.js より後に読み込む
 *
 * 動作：案件管理(App:180)のレコード詳細に「📄 請求書発行」ボタンを設置
 * → ボタン押下 → GAS WebApp経由でMF請求書を作成
 * → 完了後にKintoneレコードの mf_billing_url / mf_billing_share_url を更新
 */

(function () {
  'use strict';

  // ============================================================
  // ボタンを追加するイベント（詳細表示 / 編集完了後）
  // ============================================================
  kintone.events.on([
    'app.record.detail.show'
  ], function (event) {
    var record = event.record;

    // 既にボタンが存在する場合はスキップ
    if (document.getElementById('mf-invoice-btn-wrap')) {
      return event;
    }

    // ボタン表示領域を作成
    var wrap = document.createElement('div');
    wrap.id = 'mf-invoice-btn-wrap';
    wrap.style.cssText = 'margin: 12px 0; display: flex; align-items: center; gap: 12px;';

    // 請求書発行ボタン
    var btn = document.createElement('button');
    btn.id = 'mf-invoice-btn';
    btn.textContent = MFINVOICE_CONFIG.BUTTON_LABEL;
    btn.className = 'kintoneplugin-button-dialog-ok';
    btn.style.cssText = 'font-size: 14px; padding: 8px 20px; cursor: pointer;';

    // 既存の請求書URLリンク（発行済みの場合）
    var existingUrl = (record['mf_billing_url'] && record['mf_billing_url'].value) ? record['mf_billing_url'].value : '';
    var statusMsg = document.createElement('span');
    statusMsg.id = 'mf-invoice-status';
    statusMsg.style.cssText = 'font-size: 13px;';

    if (existingUrl) {
      btn.textContent = '📄 請求書を再発行';
      statusMsg.innerHTML = '✅ 発行済：<a href="' + existingUrl + '" target="_blank">請求書を開く</a>';
      var shareUrl = (record['mf_billing_share_url'] && record['mf_billing_share_url'].value) ? record['mf_billing_share_url'].value : '';
      if (shareUrl) {
        statusMsg.innerHTML += '　<a href="' + shareUrl + '" target="_blank">共有リンク</a>';
      }
    }

    // ボタンクリック処理
    btn.addEventListener('click', function () {
      // 確認ダイアログ
      var partnerName = (record['name_partner'] && record['name_partner'].value) ? record['name_partner'].value : '（取引先未設定）';
      var amount = (record['売上合計_税別'] && record['売上合計_税別'].value) ? Number(record['売上合計_税別'].value).toLocaleString() : '0';
      var confirmed = window.confirm(
        '以下の内容で請求書を発行します。\n\n' +
        '取引先：' + partnerName + '\n' +
        '金額（税別）：¥' + amount + '\n\n' +
        'よろしいですか？'
      );
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = '⏳ 発行中...';
      statusMsg.textContent = '';

      // GASへ送るデータ（GAS側のフィールド名に合わせてマッピング）
      var payload = {
        action: 'create_invoice',
        record_id: record['$id'].value,
        record: {
          '取引先':          (record['name_partner'] && record['name_partner'].value)      || '',
          '案件番号':        (record['project_number'] && record['project_number'].value)   || '',
          '企画名':          (record['project_name'] && record['project_name'].value)       || '',
          '売上合計（税別）': (record['売上合計_税別'] && record['売上合計_税別'].value)      || '0',
          'メールアドレス':  getEmail(record),
          '電話番号':        (record['電話番号'] && record['電話番号'].value)                || '',
          '郵便番号':        (record['zip'] && record['zip'].value)                         || '',
          '都道府県':        (record['prefecture'] && record['prefecture'].value)            || '',
          '住所1':           '',
          '住所2':           '',
          '氏名':            (record['person_name'] && record['person_name'].value)         || ''
        }
      };

      // GAS WebApp へ POST
      fetch(MFINVOICE_CONFIG.GAS_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // GASのdoPostはtext/plainで受け取る
        body: JSON.stringify(payload)
      })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result.success) {
          statusMsg.innerHTML =
            '✅ 請求書を発行しました！　' +
            '<a href="' + result.invoice_url + '" target="_blank">PDFを開く</a>' +
            (result.share_url ? '　<a href="' + result.share_url + '" target="_blank">共有リンク</a>' : '');
          btn.textContent = '📄 請求書を再発行';
          btn.disabled = false;

          // ページをリロードして書き戻し後の値を反映
          setTimeout(function () {
            kintone.app.record.setFieldShown('mf_billing_url', true);
            location.reload();
          }, 1500);
        } else {
          statusMsg.textContent = '❌ エラー：' + (result.error || '不明なエラー');
          btn.textContent = MFINVOICE_CONFIG.BUTTON_LABEL;
          btn.disabled = false;
          console.error('MF Invoice Error:', result);
        }
      })
      .catch(function (err) {
        statusMsg.textContent = '❌ 通信エラー：' + err.message;
        btn.textContent = MFINVOICE_CONFIG.BUTTON_LABEL;
        btn.disabled = false;
        console.error('fetch error:', err);
      });
    });

    wrap.appendChild(btn);
    wrap.appendChild(statusMsg);

    // ヘッダースペースに追加
    kintone.app.record.getHeaderMenuSpaceElement().appendChild(wrap);

    return event;
  });

  // ============================================================
  // メールアドレスを取得するヘルパー（_0〜_5のいずれかを使う）
  // ============================================================
  function getEmail(record) {
    var keys = ['メールアドレス_0', 'メールアドレス_1', 'メールアドレス_2'];
    for (var i = 0; i < keys.length; i++) {
      if (record[keys[i]] && record[keys[i]].value) {
        return record[keys[i]].value;
      }
    }
    return '';
  }

})();
