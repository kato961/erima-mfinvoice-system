/**
 * Kintone MF請求書連携 設定ファイル
 * kintone-mfinvoice-project.js より先に読み込む
 * fileKey: 20261124073231EF6E8514B2C74FCFA07E9A2DF022689E150
 */
var MFINVOICE_CONFIG = {
  // GAS WebApp URL（デプロイ後に設定）
  // 例: 'https://script.google.com/macros/s/XXXXX/exec'
  GAS_WEBAPP_URL: 'YOUR_GAS_WEBAPP_URL_HERE',

  // Kintone App ID
  APP_ID: 180,

  // ボタン表示設定
  BUTTON_LABEL: '📄 請求書発行',
  BUTTON_CLASS: 'mf-invoice-btn'
};
